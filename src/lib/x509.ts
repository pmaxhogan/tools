/**
 * Lazy loader for `@peculiar/x509`, shared by certificate-decoder and
 * self-signed-certificate-generator.
 *
 * `@peculiar/x509` depends on tsyringe, which throws at module-evaluation
 * time ("tsyringe requires a reflect polyfill...") unless `reflect-metadata`
 * has already installed `Reflect.getMetadata`. Each tool's index.ts imports
 * "reflect-metadata" as its first statement for exactly that reason, but a
 * static `import * as x509 from "@peculiar/x509"` is not safe in the
 * production build: rolldown places `@peculiar/x509` in a chunk shared by
 * both tools, and that shared chunk can evaluate before the tool module's
 * own reflect-metadata side-effect import runs, so the throw happens first.
 *
 * Loading it dynamically defers evaluation until first use, which is always
 * after the importing tool module (which puts "reflect-metadata" first) has
 * started running, so the polyfill is installed before this resolves.
 */
export type X509 = typeof import("@peculiar/x509");

let x509Promise: Promise<X509> | undefined;

export function loadX509(): Promise<X509> {
  return (x509Promise ??= import("@peculiar/x509"));
}
