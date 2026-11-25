// Copy the dashboard's static files next to the compiled server (tsc only emits .js from .ts)
import { cpSync, rmSync } from "node:fs";

const target = new URL("../build/web/public/", import.meta.url);
rmSync(target, { recursive: true, force: true });
cpSync(new URL("../src/web/public/", import.meta.url), target, { recursive: true });
