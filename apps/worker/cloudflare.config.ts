import { bindings, defineConfig, exports, triggers } from "cf/config";

// Deployment settings for the hosted instance. Self-hosters: set IH_DOMAIN and IH_D1_ID
// (from `cf d1 create --name idle-hands`) instead of editing this file.
const domain = process.env.IH_DOMAIN ?? "idlehands.paulashraf.com";
const d1Id = process.env.IH_D1_ID ?? "76385b0f-2c19-46e1-be65-49bd21f7f639";

// D1 schema lives in ./migrations. Apply before deploying a schema change:
//   cf d1 migrations apply <IH_D1_ID> --dir migrations
export default defineConfig({
	worker: {
		name: "idle-hands",
		compatibilityDate: "2026-11-01",
		entrypoint: "src/index.ts",
		domains: [domain],
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*", "/api"],
		},
		triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
		exports: {
			LiveHub: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			DB: bindings.d1({ name: "idle-hands", id: d1Id }),
			LIVE: bindings.durableObject({ worker: "idle-hands", exportName: "LiveHub" }),
			ASSETS: bindings.assets(),
		},
		observability: { enabled: true },
	},
});
