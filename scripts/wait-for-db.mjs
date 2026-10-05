import { execSync } from "node:child_process";

const deadline = Date.now() + 60_000;
process.stdout.write("waiting for postgres");
while (Date.now() < deadline) {
  try {
    execSync("docker compose exec -T db pg_isready -U bulletz -d bulletz", { stdio: "ignore" });
    console.log(" ready");
    process.exit(0);
  } catch {
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1500));
  }
}
console.error("\npostgres did not become ready in 60s");
process.exit(1);
