/**
 * The confirm pane: the last human step before anything reaches GitHub
 * (design.md, "Web UI", PR detail footer; R6.4, R6.5, R6.6).
 *
 * What it shows, in the order the user needs it: the rendered review body in
 * an editable field, the findings that will post grouped by file, then the
 * findings that cannot attach. That second list gets its own heading rather
 * than a greyed-out row in the first, and every entry carries the reason its
 * line was refused. After a post it shows the per-finding outcome and the
 * link that opens the pending draft on GitHub, which is the only place a
 * review is ever submitted (ADR 0001).
 *
 * The state machine is `createPostController`, a plain factory in the same
 * shape as hooks.ts's `createEventStream` and the daemon's `createScheduler`:
 * subscribe, snapshot, drive it, assert. That is not decoration either. This
 * SPA's only test harness is `renderToStaticMarkup`, which never runs
 * effects and has no DOM, so a state machine living inside a component could
 * not be exercised at all. This is the one surface where an untested
 * transition posts something the user did not choose.
 *
 * Three behaviours worth naming, because each one is a way to lose work:
 *
 *  - The post button is disabled while a post is in flight, and the
 *    controller refuses a second call on its own. Double-clicking must not
 *    create two drafts; the REST API has no way to merge them, and the
 *    second create would leave a draft LGTM does not know about.
 *  - Recreate REPLACES the existing draft. It deletes the draft on GitHub
 *    and posts fresh, because the REST API cannot append to a pending review
 *    (R6.5). The pane says so in those words before offering the button.
 *    That sentence is the difference between editing a review and losing
 *    one.
 *  - A body the human has edited is never overwritten by a reload of the
 *    preview, and it is sent verbatim, empty included.
 */

import { useEffect, useMemo, useState } from "react";
import type { PRRef } from "@/core";
import { getDefaultGateActions } from "@/ui/actions";
import type { ActionError, GateActions, GateVerdict, PostPreview, PostedDraft } from "@/ui/actions";
import { REAUTH_MESSAGE } from "@/ui/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// ─── State ──────────────────────────────────────────────────────────────────

export type PreviewState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; preview: PostPreview }
  /** Every finding missed the current diff, so the post aborts before any GitHub call (R6.3). */
  | { phase: "empty"; checked: number; held: GateVerdict[]; message: string }
  | { phase: "error"; error: ActionError };

export type PostOutcome =
  | { kind: "posted"; draft: PostedDraft }
  | { kind: "nothing-to-post"; checked: number; held: GateVerdict[]; message: string }
  | { kind: "draft-exists"; pendingReviewId: number | null; reviewUrl: string | null; message: string }
  | { kind: "error"; error: ActionError };

export interface PostState {
  preview: PreviewState;
  /** Seeded from the preview, then owned by the human. */
  body: string;
  bodyEdited: boolean;
  posting: boolean;
  /** A draft GitHub already holds, from the preview or from a refusal. Drives the recreate offer. */
  existingDraft: { pendingReviewId: number | null; reviewUrl: string | null } | null;
  outcome: PostOutcome | null;
}

export interface PostController {
  snapshot(): PostState;
  subscribe(listener: (state: PostState) => void): () => void;
  /** Run the dry run that fills the pane. Writes nothing, anywhere. */
  load(): Promise<void>;
  setBody(body: string): void;
  post(options?: { recreate?: boolean }): Promise<void>;
}

export interface PostControllerOptions {
  ref: PRRef;
  /** Defaults to the shared instance, resolved at call time so building a controller touches no globals. */
  actions?: GateActions;
}

const INITIAL: PostState = {
  preview: { phase: "idle" },
  body: "",
  bodyEdited: false,
  posting: false,
  existingDraft: null,
  outcome: null,
};

export function createPostController(options: PostControllerOptions): PostController {
  let state: PostState = INITIAL;
  const listeners = new Set<(state: PostState) => void>();

  function gate(): GateActions {
    return options.actions ?? getDefaultGateActions();
  }

  function set(patch: Partial<PostState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  return {
    snapshot: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async load() {
      if (state.preview.phase === "loading") return;
      set({ preview: { phase: "loading" }, outcome: null });

      const result = await gate().preview(options.ref);

      switch (result.status) {
        case "preview": {
          const preview = result.preview;
          set({
            preview: { phase: "ready", preview },
            body: state.bodyEdited ? state.body : preview.body,
            existingDraft:
              preview.pendingReviewId === null
                ? null
                : { pendingReviewId: preview.pendingReviewId, reviewUrl: `${preview.url}/files` },
          });
          break;
        }

        case "nothing-to-post":
          set({ preview: { phase: "empty", checked: result.checked, held: result.held, message: result.message } });
          break;

        case "draft-exists":
          // A dry run skips the existing-draft step entirely, so this is the
          // daemon disagreeing with its own contract. Show it rather than
          // swallow it.
          set({
            preview: { phase: "error", error: { kind: "http", message: result.message, code: "pending-review-exists", status: 409 } },
            existingDraft: { pendingReviewId: result.pendingReviewId, reviewUrl: result.reviewUrl },
          });
          break;

        case "posted":
          set({
            preview: {
              phase: "error",
              error: {
                kind: "http",
                message: "The dry run came back as a created review. Nothing was previewed; check the daemon log.",
                code: null,
                status: null,
              },
            },
          });
          break;

        case "error":
          set({ preview: { phase: "error", error: result.error } });
          break;
      }
    },

    setBody(body) {
      set({ body, bodyEdited: true });
    },

    async post(postOptions = {}) {
      const recreate = postOptions.recreate === true;

      // The double-click guard. A second create call cannot be merged with
      // the first, and the API answers a real one with a draft LGTM would
      // then hold two records of.
      if (state.posting) return;
      if (state.outcome?.kind === "posted" && !recreate) return;
      if (state.preview.phase !== "ready") return;

      set({ posting: true, outcome: null });

      const result = await gate().post(options.ref, {
        body: state.body,
        ...(recreate ? { recreate: true } : {}),
      });

      switch (result.status) {
        case "posted":
          set({
            posting: false,
            outcome: { kind: "posted", draft: result.draft },
            existingDraft: { pendingReviewId: result.draft.reviewId, reviewUrl: result.draft.reviewUrl },
          });
          break;

        case "draft-exists":
          set({
            posting: false,
            outcome: {
              kind: "draft-exists",
              pendingReviewId: result.pendingReviewId,
              reviewUrl: result.reviewUrl,
              message: result.message,
            },
            existingDraft: { pendingReviewId: result.pendingReviewId, reviewUrl: result.reviewUrl },
          });
          break;

        case "nothing-to-post":
          set({
            posting: false,
            outcome: { kind: "nothing-to-post", checked: result.checked, held: result.held, message: result.message },
          });
          break;

        case "preview":
          set({
            posting: false,
            outcome: {
              kind: "error",
              error: {
                kind: "http",
                message: "The daemon answered a real post with a dry run. Nothing was sent to GitHub.",
                code: null,
                status: null,
              },
            },
          });
          break;

        case "error":
          set({ posting: false, outcome: { kind: "error", error: result.error } });
          break;
      }
    },
  };
}

// ─── Presentation ───────────────────────────────────────────────────────────

export function groupVerdictsByFile(verdicts: readonly GateVerdict[]): Array<[string, GateVerdict[]]> {
  const groups = new Map<string, GateVerdict[]>();
  for (const verdict of verdicts) {
    const list = groups.get(verdict.file);
    if (list) list.push(verdict);
    else groups.set(verdict.file, [verdict]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.line - b.line || a.round - b.round);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function VerdictLine({ verdict }: { verdict: GateVerdict }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1 text-sm" data-finding-key={verdict.key}>
      <code className="text-xs text-muted-foreground">{verdict.key}</code>
      <span className="font-mono text-xs">line {verdict.line}</span>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{verdict.severity}</span>
    </div>
  );
}

function PostableList({ verdicts }: { verdicts: GateVerdict[] }) {
  return (
    <section data-testid="postable-list" className="space-y-3">
      <h3 className="text-sm font-semibold">Will post ({verdicts.length})</h3>
      {groupVerdictsByFile(verdicts).map(([file, group]) => (
        <div key={file} className="rounded-md border p-3">
          <div className="font-mono text-xs font-medium">{file}</div>
          <div className="mt-1 divide-y">
            {group.map((verdict) => (
              <VerdictLine key={verdict.key} verdict={verdict} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * Held findings get their own heading, never a greyed-out row inside the
 * first list. They are not posting, they are staying on disk with a reason,
 * and they are retried at the next post (R6.3).
 */
function HeldList({ verdicts, heading }: { verdicts: GateVerdict[]; heading: string }) {
  if (verdicts.length === 0) return null;

  return (
    <section data-testid="held-list" className="space-y-2">
      <h3 className="text-sm font-semibold">
        {heading} ({verdicts.length})
      </h3>
      <div className="rounded-md border border-dashed p-3">
        {verdicts.map((verdict) => (
          <div key={verdict.key} className="py-1 text-sm" data-finding-key={verdict.key}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <code className="text-xs text-muted-foreground">{verdict.key}</code>
              <span className="font-mono text-xs">
                {verdict.file}:{verdict.line}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{verdict.reason ?? "No reason given."}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const RECREATE_WARNING =
  "Recreate deletes that draft on GitHub and posts a new one. It replaces the existing draft rather than adding to it, so any comments you edited there are lost.";

function ExistingDraftNotice({
  draft,
  onRecreate,
  busy,
  refusal,
}: {
  draft: { pendingReviewId: number | null; reviewUrl: string | null };
  onRecreate: () => void;
  busy: boolean;
  /** The daemon refusing this post because that draft is still pending. */
  refusal?: string | null;
}) {
  return (
    <div data-testid="existing-draft" className="space-y-2 rounded-md border border-yellow-500/50 bg-yellow-50 p-3 dark:bg-yellow-950/30">
      {refusal && (
        <p className="text-sm text-destructive" data-testid="post-outcome">
          {refusal}
        </p>
      )}
      <p className="text-sm font-medium">
        This PR already has a pending draft review
        {draft.pendingReviewId === null ? "" : ` (#${draft.pendingReviewId})`}.
      </p>
      <p className="text-sm text-muted-foreground">{RECREATE_WARNING}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          data-testid="recreate-draft"
          disabled={busy}
          onClick={onRecreate}
        >
          Recreate draft
        </Button>
        {draft.reviewUrl && (
          <a
            href={draft.reviewUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Open the existing draft on GitHub →
          </a>
        )}
      </div>
    </div>
  );
}

function ErrorNotice({ error }: { error: ActionError }) {
  return (
    <p data-testid="post-error" className="text-sm text-destructive">
      {error.kind === "unauthenticated" ? REAUTH_MESSAGE : error.message}
    </p>
  );
}

function PostedOutcome({ draft }: { draft: PostedDraft }) {
  return (
    <div className="space-y-4" data-testid="post-outcome">
      <p className="text-sm font-medium">
        Posted {plural(draft.posted.length, "finding")} as a pending draft review
        {draft.held.length > 0 ? `, held ${draft.held.length} back` : ""}.
      </p>

      {draft.recreated && (
        <p className="text-sm text-muted-foreground">
          Replaced draft #{draft.recreated.deletedReviewId}. {plural(draft.recreated.reopened.length, "finding")} from
          it went back to open, since their comments left GitHub with it.
        </p>
      )}
      {draft.clearedReviewId !== null && (
        <p className="text-sm text-muted-foreground">
          The recorded draft #{draft.clearedReviewId} was already submitted or deleted on GitHub, so that record was
          cleared.
        </p>
      )}

      <section data-testid="posted-list" className="space-y-2">
        <h3 className="text-sm font-semibold">Posted ({draft.posted.length})</h3>
        <div className="rounded-md border p-3">
          {draft.posted.map((verdict) => (
            <div key={verdict.key} className="py-1 text-sm" data-finding-key={verdict.key}>
              <code className="text-xs text-muted-foreground">{verdict.key}</code>{" "}
              <span className="font-mono text-xs">
                {verdict.file}:{verdict.line}
              </span>
            </div>
          ))}
        </div>
      </section>

      <HeldList verdicts={draft.held} heading="Held back, retried at the next post" />

      <a
        href={draft.reviewUrl}
        target="_blank"
        rel="noreferrer"
        data-testid="open-pending-review"
        className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        Open pending review on GitHub →
      </a>
      <p className="text-xs text-muted-foreground">
        Only you can see it. Submit it there when it reads right; LGTM cannot submit a review.
      </p>
    </div>
  );
}

// ─── The pane ───────────────────────────────────────────────────────────────

function usePostState(controller: PostController): PostState {
  const [state, setState] = useState<PostState>(() => controller.snapshot());

  useEffect(() => {
    setState(controller.snapshot());
    return controller.subscribe(setState);
  }, [controller]);

  return state;
}

export interface PostPaneProps {
  prRef: PRRef;
  /** Injected by tests, which drive it directly; the pane builds its own otherwise. */
  controller?: PostController;
  actions?: GateActions;
  onClose?: () => void;
}

export function PostPane({ prRef, controller, actions, onClose }: PostPaneProps) {
  const fallback = useMemo(
    () => createPostController({ ref: prRef, ...(actions ? { actions } : {}) }),
    [prRef.owner, prRef.repo, prRef.number, actions],
  );
  const active = controller ?? fallback;
  const state = usePostState(active);

  useEffect(() => {
    void active.load();
  }, [active]);

  const prKey = `${prRef.owner}/${prRef.repo}#${prRef.number}`;
  const ready = state.preview.phase === "ready" ? state.preview.preview : null;
  const postedAlready = state.outcome?.kind === "posted";
  const postDisabled = state.posting || postedAlready || ready === null || ready.postable.length === 0;

  return (
    <section data-testid="post-pane" className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Post draft review</h2>
          <p className="text-sm text-muted-foreground">
            {prKey}. LGTM creates a PENDING draft only you can see. You submit it in GitHub.
          </p>
        </div>
        {onClose && (
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        )}
      </header>

      {state.preview.phase === "loading" && (
        <p className="text-sm text-muted-foreground">Checking every finding against the current diff…</p>
      )}

      {state.preview.phase === "error" && <ErrorNotice error={state.preview.error} />}

      {state.preview.phase === "empty" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{state.preview.message}</p>
          <HeldList verdicts={state.preview.held} heading="Cannot attach to the current diff" />
        </div>
      )}

      {ready && !postedAlready && (
        <div className="space-y-6">
          {state.existingDraft && (
            <ExistingDraftNotice
              draft={state.existingDraft}
              busy={state.posting}
              onRecreate={() => void active.post({ recreate: true })}
              refusal={state.outcome?.kind === "draft-exists" ? state.outcome.message : null}
            />
          )}

          <div className="space-y-2">
            <Label htmlFor="review-body">Review body</Label>
            <Textarea
              id="review-body"
              data-testid="review-body"
              rows={10}
              value={state.body}
              disabled={state.posting}
              onChange={(event) => active.setBody(event.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Rendered from templates/review-body.md. Edit it here; it is sent exactly as it reads.
            </p>
          </div>

          <PostableList verdicts={ready.postable} />
          <HeldList verdicts={ready.held} heading="Cannot attach to the current diff" />

          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button type="button" data-testid="post-draft" disabled={postDisabled} onClick={() => void active.post()}>
              {state.posting ? "Posting…" : `Post draft (${plural(ready.postable.length, "finding")})`}
            </Button>
            <span className="text-xs text-muted-foreground">
              Creates the draft. Nothing is published until you submit it on GitHub.
            </span>
          </div>
        </div>
      )}

      {state.outcome?.kind === "posted" && <PostedOutcome draft={state.outcome.draft} />}

      {state.outcome?.kind === "nothing-to-post" && (
        <div className="space-y-4" data-testid="post-outcome">
          <p className="text-sm text-muted-foreground">{state.outcome.message}</p>
          <HeldList verdicts={state.outcome.held} heading="Cannot attach to the current diff" />
        </div>
      )}


      {state.outcome?.kind === "error" && (
        <div data-testid="post-outcome">
          <ErrorNotice error={state.outcome.error} />
          <p className="text-xs text-muted-foreground">Nothing was posted. The findings are unchanged on disk.</p>
        </div>
      )}
    </section>
  );
}

export default PostPane;
