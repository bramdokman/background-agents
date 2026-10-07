import { Hono } from "hono";
import {
  createTeamGitHubLinkRequestSchema,
  teamGitHubLinkResponseSchema,
  teamGitHubLinksResponseSchema,
} from "@open-inspect/shared/types/teams";
import type { TeamAuditActor } from "../db/team-audit";
import { TeamGitHubLinkStore } from "../db/team-github-links";
import type { RequestContext } from "../http/request-context";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  error,
  json,
  permissionRequirement,
  requireAll,
} from "./shared";

function admitted(ctx: RequestContext): { teamId: string; actor: TeamAuditActor } {
  if (!ctx.teamAdmission || ctx.principal?.kind !== "user") {
    throw new Error("Team route not admitted");
  }
  return {
    teamId: ctx.teamAdmission.team.id,
    actor: { requestId: ctx.request_id, actorUserId: ctx.principal.userId },
  };
}

async function listLinks(
  _request: Request,
  _env: Env,
  _params: { id: string },
  ctx: RequestContext
) {
  return json(
    teamGitHubLinksResponseSchema.parse({
      links: await new TeamGitHubLinkStore(ctx.db).listForTeam(admitted(ctx).teamId),
    })
  );
}

/** Links a GitHub team; a repeat answers the existing link with 200 rather than a conflict. */
async function createLink(
  request: Request,
  _env: Env,
  _params: { id: string },
  ctx: RequestContext
) {
  const body = await parseBody(request, createTeamGitHubLinkRequestSchema);
  if (body instanceof Response) return body;
  const { teamId, actor } = admitted(ctx);
  if (ctx.teamAdmission?.team.archivedAt !== null) {
    return json({ error: "Team is not active", code: "team_not_active" }, 409);
  }
  const { link, created } = await new TeamGitHubLinkStore(ctx.db).add(teamId, body, actor);
  return json(teamGitHubLinkResponseSchema.parse({ link }), created ? 201 : 200);
}

async function deleteLink(
  _request: Request,
  _env: Env,
  params: { id: string; githubOrg: string; githubTeamSlug: string },
  ctx: RequestContext
) {
  const { teamId, actor } = admitted(ctx);
  const removed = await new TeamGitHubLinkStore(ctx.db).remove(
    teamId,
    params.githubOrg,
    params.githubTeamSlug,
    actor
  );
  return removed ? new Response(null, { status: 204 }) : error("GitHub team link not found", 404);
}

export const teamGitHubLinkRoutes = new Hono<ControlPlaneHonoEnv>();
/**
 * Linking decides who joins a team automatically, so it takes the workspace
 * member-management permission (Owners and Administrators) on top of the
 * team's own member-management capability; team leads alone cannot link.
 */
const manageLinks = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  cacheControl: "private, no-store",
  authorization: {
    ...requireAll(
      { kind: "team", teamIdParam: "id", need: "canManageMembers" },
      permissionRequirement("workspace.members.manage")
    ),
    service: { kind: "deny" },
  },
});

teamGitHubLinkRoutes.get("/teams/:id/github-links", manageLinks, (c) => dispatch(c, listLinks));
teamGitHubLinkRoutes.post("/teams/:id/github-links", manageLinks, (c) => dispatch(c, createLink));
teamGitHubLinkRoutes.delete(
  "/teams/:id/github-links/:githubOrg/:githubTeamSlug",
  manageLinks,
  (c) => dispatch(c, deleteLink)
);
