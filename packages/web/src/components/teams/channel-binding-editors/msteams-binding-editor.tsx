"use client";

import { useState } from "react";
import type { BindingEditor, BindingEditorParams } from "./binding-editor";

export function useMsTeamsBindingEditor({ id, disabled }: BindingEditorParams): BindingEditor {
  const [channelId, setChannelId] = useState("");
  const externalId = channelId.trim();

  return {
    providerLabel: "Microsoft Teams",
    bindLabel: "Bind channel",
    locked: false,
    externalId,
    canSubmit: !disabled && externalId.length > 0,
    clearDraft: () => setChannelId(""),
    reset: () => setChannelId(""),
    field: (
      <>
        <label
          id={`${id}-channel-label`}
          htmlFor={`${id}-channel`}
          className="block text-sm font-medium"
        >
          Microsoft Teams channel ID
        </label>
        <input
          id={`${id}-channel`}
          value={channelId}
          onChange={(event) => setChannelId(event.target.value)}
          placeholder="19:...@thread.tacv2"
          autoComplete="off"
          disabled={disabled}
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
        />
      </>
    ),
    footer: (
      <p className="text-xs text-muted-foreground">
        Enter the channel ID from the channel&apos;s link (the <code>19:...@thread.tacv2</code>{" "}
        value), not its name. Enter a bound channel&apos;s ID to change its kind.
      </p>
    ),
    displayName: (externalId) => externalId,
    unbindLabel: (externalId) => `Unbind Microsoft Teams channel ${externalId}`,
  };
}
