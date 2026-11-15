// AGT-122: the Worker with neither, to take away from the other two sizes.
import { DurableObject } from "cloudflare:workers";

export class LightWorkspace extends DurableObject {}
export class FakeGitHub extends DurableObject {}
export default { fetch: () => new Response(null, { status: 404 }) } satisfies ExportedHandler;
