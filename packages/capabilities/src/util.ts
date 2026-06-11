import * as os from "node:os";
import * as path from "node:path";

export function expandHome(p: string): string {
  if (p === "~") return os.homedir() || p;
  if (p.startsWith("~/") || p.startsWith("~" + path.sep)) {
    const home = os.homedir();
    if (!home) return p;
    return path.join(home, p.slice(2));
  }
  return p;
}
