import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import { EnvironmentStore, toEnvironment, type EnvironmentRow } from "../db/environments";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
} from "../router.test-support";
import { environmentRoutes } from "./environments";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));
afterEach(() => vi.restoreAllMocks());

const TEAMS_CHANNEL_ID = "19:0123456789abcdef0123456789abcdef@thread.tacv2";

/** Each binding provider, the bot that may scope by it, and the actor namespace that bot asserts. */
const CHANNEL_SCOPES = [
  { provider: "slack", service: "slack-bot", actorProvider: "slack", externalId: "C-CATALOG" },
  { provider: "linear", service: "linear-bot", actorProvider: "linear", externalId: "C-CATALOG" },
  {
    provider: "msteams",
    service: "teams-bot",
    actorProvider: "microsoft",
    externalId: TEAMS_CHANNEL_ID,
  },
] as const;

describe("environment catalog channel scope", () => {
  it.each(CHANNEL_SCOPES)(
    "scopes an acting $service using its canonical actor's actual membership",
    async ({ provider, service, actorProvider, externalId }) => {
      const teamId = "team_selected";
      const row: EnvironmentRow = {
        id: "env_covered",
        owner_team_id: null,
        name: "covered",
        description: null,
        prebuild_enabled: 0,
        channel_associations: null,
        created_at: 1,
        updated_at: 1,
      };
      const repositories = [
        {
          environment_id: row.id,
          position: 0,
          repo_owner: "acme",
          repo_name: "repo-1",
          repo_id: 1,
          base_branch: "main",
        },
      ];
      mocks.authenticate.mockImplementation(async (request: Request) => ({
        principal: {
          kind: "service",
          service,
          actor: {
            provider: actorProvider,
            providerUserId: "U_ACTOR",
            participantUserId: `${actorProvider}:U_ACTOR`,
            canonicalUserId: "user-1",
          },
        },
        request,
      }));
      const binding = vi.spyOn(TeamChannelBindingStore.prototype, "get").mockResolvedValue({
        provider,
        externalId,
        teamId,
        kind: "source",
      });
      vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
      const membership = vi
        .spyOn(TeamMembershipStore.prototype, "listForUser")
        .mockResolvedValue(new Map([[teamId, "member"]]));
      vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([
        { grant_kind: "repository", repo_external_id: 1 },
      ]);
      vi.spyOn(EnvironmentStore.prototype, "list").mockResolvedValue({
        environments: [row],
        total: 1,
      });
      vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironmentIds").mockResolvedValue(
        new Map([[row.id, repositories]])
      );
      const handleRequest = createTestRequestHandler([environmentRoutes]);

      const response = await handleRequest(
        new Request(
          `https://test.local/environments?channel=${encodeURIComponent(`${provider}:${externalId}`)}`
        ),
        createTestEnv({ DB: authorizationDatabase({ permissions: ["environments.read"] }) }),
        TEST_BACKGROUND_TASK_CONTEXT
      );

      expect(response.status).toBe(200);
      expect(binding).toHaveBeenCalledWith(provider, externalId);
      expect(await response.json()).toEqual({
        environments: [
          {
            ...toEnvironment(row, repositories),
            capabilities: {
              canRead: true,
              canManage: false,
              canUse: false,
            },
          },
        ],
        total: 1,
      });
      expect(membership.mock.calls.length).toBeGreaterThan(0);
      expect(membership.mock.calls.every(([userId]) => userId === "user-1")).toBe(true);
    }
  );

  function actingBot(service: "slack-bot" | "linear-bot" | "teams-bot") {
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: {
        kind: "service",
        service,
        actor: {
          provider: "microsoft",
          providerUserId: "U_ACTOR",
          participantUserId: "microsoft:U_ACTOR",
          canonicalUserId: "user-1",
        },
      },
      request,
    }));
  }

  async function catalog(query: string) {
    const handleRequest = createTestRequestHandler([environmentRoutes]);
    return handleRequest(
      new Request(`https://test.local/environments?${query}`),
      createTestEnv({ DB: authorizationDatabase({ permissions: ["environments.read"] }) }),
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  it.each([
    ["slack-bot", 403],
    ["linear-bot", 403],
    ["teams-bot", 200],
  ] as const)(
    "admits only the Teams bot to a Microsoft Teams channel scope (%s)",
    async (service, status) => {
      actingBot(service);
      const binding = vi.spyOn(TeamChannelBindingStore.prototype, "get").mockResolvedValue(null);
      vi.spyOn(EnvironmentStore.prototype, "list").mockResolvedValue({
        environments: [],
        total: 0,
      });
      vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironmentIds").mockResolvedValue(
        new Map()
      );

      const response = await catalog(
        `channel=${encodeURIComponent(`msteams:${TEAMS_CHANNEL_ID}`)}`
      );

      expect(response.status).toBe(status);
      if (status === 403) {
        expect(await response.json()).toEqual({
          error: "Microsoft Teams channel scope denied",
          code: "msteams_channel_scope_denied",
        });
        expect(binding).not.toHaveBeenCalled();
      } else {
        expect(binding).toHaveBeenCalledWith("msteams", TEAMS_CHANNEL_ID);
      }
    }
  );

  it.each([
    [`channel=${encodeURIComponent(`msteams:${TEAMS_CHANNEL_ID}`)}&teamId=team_other`, 400],
    ["channel=msteams%3A19%3Aabc", 400],
    ["channel=msteams%3AC-CATALOG", 400],
    [
      `channel=${encodeURIComponent(`msteams:${TEAMS_CHANNEL_ID}`)}&channel=msteams%3A19%3Ax%40y`,
      400,
    ],
  ] as const)("refuses the Teams bot's malformed or overridden scope %s", async (query, status) => {
    actingBot("teams-bot");
    const binding = vi.spyOn(TeamChannelBindingStore.prototype, "get").mockResolvedValue(null);

    const response = await catalog(query);

    expect(response.status).toBe(status);
    expect(binding).not.toHaveBeenCalled();
  });

  it("denies a channel-scoped bot's bare teamId override", async () => {
    actingBot("teams-bot");
    vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
    const binding = vi.spyOn(TeamChannelBindingStore.prototype, "get").mockResolvedValue(null);

    const response = await catalog("teamId=team_selected");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Team not found" });
    expect(binding).not.toHaveBeenCalled();
  });
});
