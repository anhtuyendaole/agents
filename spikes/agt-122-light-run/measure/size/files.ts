// AGT-122: what the filesystem alone adds to a Worker's upload.

import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";

export class LightWorkspace extends DurableObject {
	readonly workspace = new Workspace({ storage: this.ctx.storage });
}
export class FakeGitHub extends DurableObject {}
export default { fetch: () => new Response(null, { status: 404 }) } satisfies ExportedHandler;
