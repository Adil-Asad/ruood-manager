/**
 * What every route needs, and the two rules it enforces for all of them.
 *
 * **One repository, chosen at startup.** The CLI takes `--repo` on every
 * command because there is no ambient "current repository" — publishing to the
 * wrong one is not a mistake worth leaving available. The server keeps that
 * property by binding to one root for its whole life: there is no route that
 * takes a path, so no request can redirect the Manager at another checkout.
 *
 * **`now` is injected.** Nothing under `src/` reads the clock directly; the
 * context hands one out. In production it is `Date.now`, and a test passes a
 * fixed instant — which is the only way to assert on a derived lifecycle state
 * or a schedule warning at all.
 */

import { basename } from 'node:path';

import { repoPaths, type RepoPaths } from '@ruood/announcement-core';

export interface ServerContext {
  root: string;
  name: string;
  paths: RepoPaths;
  now: () => number;
}

export function createContext(root: string, now: () => number = Date.now): ServerContext {
  return {
    root,
    name: basename(root) || root,
    paths: repoPaths(root),
    now,
  };
}
