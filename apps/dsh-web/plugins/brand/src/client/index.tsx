/**
 * Fill the sidebar brand slots with CCA's own identity.
 *
 * This is a vendored counterpart of `@deepseek-ai/dsh-client-ui-brand-official`
 * that reads from the same slot contracts; the stock occupant is disabled in
 * the CCA overlay so exactly one registrant owns each slot.
 */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { CcaBrandMark, CcaBrandName } from "./Brand";

/** Required service: the UI slot registry. */
export const inject = ["slots"];

/**
 * Register both brand slots as one declaration-aware registration set.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject("sidebar.brand.mark", () =>
    ctx.slots.inject("sidebar.brand.name", function* () {
      yield ctx.slots.register({ name: "sidebar.brand.mark" }, CcaBrandMark);
      yield ctx.slots.register({ name: "sidebar.brand.name" }, CcaBrandName);
    }));
}
