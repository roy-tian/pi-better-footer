import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFooter from "./footer/index";
import registerRecentModel from "./recent-model";
import registerSkipUnavailable from "./skip-unavailable";
import { loadSettings, saveSettings } from "./settings";

export default function betterFooter(pi: ExtensionAPI) {
	let settings = loadSettings();

	registerFooter(pi);
	registerRecentModel(pi, { enabled: () => settings.keepRecentModel });
	registerSkipUnavailable(pi, { enabled: () => settings.skipExhaustedScopedModels });

	pi.registerCommand("better-footer", {
		description: "Configure model/thinking persistence and skipping exhausted scoped models",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			while (true) {
				// Another Pi process may have changed the file since this one loaded it.
				settings = loadSettings();
				const shown = settings;
				const recent = `Keep model and thinking level: ${shown.keepRecentModel ? "on" : "off"}`;
				const skip = `Skip exhausted scoped models: ${shown.skipExhaustedScopedModels ? "on" : "off"}`;
				const choice = await ctx.ui.select("Better footer settings", [recent, skip]);
				if (!choice) return;
				const key = choice === recent ? "keepRecentModel" : "skipExhaustedScopedModels";
				// Flip the value the menu showed, on top of whatever is on disk now.
				const next = { ...loadSettings(), [key]: !shown[key] };
				try {
					await saveSettings(next);
					settings = next;
				} catch (error) {
					ctx.ui.notify(`Could not save better-footer settings: ${String(error)}`, "error");
					return;
				}
			}
		},
	});
}
