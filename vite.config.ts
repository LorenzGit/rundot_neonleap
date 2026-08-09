import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { rundotGameLibrariesPlugin, rundotGamePlaygroundPlugin } from "@series-inc/rundot-game-sdk/vite";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    version: string;
};
const playgroundEnabled = process.env.RUNDOT_PLAYGROUND === "1";
const plugins = [rundotGameLibrariesPlugin()];

if (playgroundEnabled) plugins.push(rundotGamePlaygroundPlugin());

export default defineConfig({
    base: "./",
    plugins,
    define: {
        __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    server: {
        allowedHosts: true,
        port: 5191,
    },
    preview: {
        allowedHosts: true,
        port: 4191,
    },
    build: {
        target: "es2022",
        chunkSizeWarningLimit: 600,
        rollupOptions: {
            output: {
                manualChunks: {
                    pixi: ["pixi.js"],
                },
            },
        },
    },
    esbuild: {
        target: "es2022",
    },
    optimizeDeps: {
        esbuildOptions: {
            target: "es2022",
        },
    },
});
