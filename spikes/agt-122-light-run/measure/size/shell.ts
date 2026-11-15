// AGT-122: what the filesystem and the worker shell add to a Worker's upload.

import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceServiceProxy } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";

export { WorkspaceServiceProxy };
export class LightWorkspace extends DurableObject<{ LOADER: WorkerLoader }> {
	readonly workspace = new Workspace({
		storage: this.ctx.storage,
		backends: [
			new WorkerShellBackend({
				loader: this.env.LOADER,
				workspace: { binding: "LIGHT", id: this.ctx.id.toString() },
				ctx: this.ctx,
			}),
		],
	});
}
export class FakeGitHub extends DurableObject {}
export default { fetch: () => new Response(null, { status: 404 }) } satisfies ExportedHandler;
