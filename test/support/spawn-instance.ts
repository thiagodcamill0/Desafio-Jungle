import type { Subprocess } from "bun";

export interface Instance {
  baseUrl: string;
  proc: Subprocess;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port!;
  await server.stop(true);
  return port;
}

// sobe a aplicação num processo Bun separado, como uma instância real
export async function spawnInstance(env: Record<string, string>, opts: { waitReady?: boolean } = {}): Promise<Instance> {
  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdout: "ignore",
    stderr: process.env.DEBUG_INSTANCES ? "inherit" : "ignore",
  });
  const baseUrl = `http://localhost:${port}`;
  const instance: Instance = { baseUrl, proc, exited: proc.exited, kill: (signal = "SIGTERM") => proc.kill(signal) };
  if (opts.waitReady === false) return instance;

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`instance exited early with ${proc.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/health/live`)).ok) return instance;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  proc.kill("SIGKILL");
  throw new Error("instance did not become live in 20s");
}
