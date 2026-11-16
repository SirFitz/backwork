// Links, navigation and GET forms that carry the environment (BAC-89): every internal link keeps
// `?env=<project>` so moving between pages never drops the viewer's choice. Use these instead of
// Remix's Link / NavLink / useNavigate on any page the picker scopes.
import { forwardRef, useCallback, useContext, useEffect } from "react";
import {
  Link as RemixLink,
  NavLink as RemixNavLink,
  useNavigate,
  type LinkProps,
  type NavLinkProps,
} from "@remix-run/react";
import { UNSAFE_DataRouterStateContext, type NavigateOptions, type To } from "react-router-dom";
import { ENV_COOKIE, ENV_COOKIE_MAX_AGE_S, ENV_PARAM, envCookieValue, parseEnvCookie, readCookie, withEnv, type EnvOption } from "~/lib/env";

/** The environment state the root loader hands the shell. */
export interface EnvState {
  /** The chosen project's slug; null when reads are organisation-wide. */
  current: string | null;
  /** The org's projects, in creation order. */
  options: Pick<EnvOption, "slug" | "name">[];
}

interface RootEnvData {
  auth: { org: { id: string }; env: EnvState } | null;
}

/** The environment every data page is reading now (from the root loader), or null. */
export function useCurrentEnv(): string | null {
  // Read through the router state context rather than useRouteLoaderData, which throws outside a
  // data router (component tests render these links in a MemoryRouter).
  const state = useContext(UNSAFE_DataRouterStateContext);
  const root = state?.loaderData?.root as RootEnvData | undefined;
  return root?.auth?.env?.current ?? null;
}

function carry(to: To, env: string | null): To {
  if (typeof to === "string") return withEnv(to, env);
  if (!to.pathname) return to; // relative object: leave it to the router
  return withEnv(`${to.pathname}${to.search ?? ""}${to.hash ?? ""}`, env);
}

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function EnvLink({ to, ...rest }, ref) {
  const env = useCurrentEnv();
  return <RemixLink ref={ref} to={carry(to, env)} {...rest} />;
});

export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function EnvNavLink({ to, ...rest }, ref) {
  const env = useCurrentEnv();
  return <RemixNavLink ref={ref} to={carry(to, env)} {...rest} />;
});

/** useNavigate that carries the environment on path navigations (a number still moves in history). */
export function useEnvNavigate(): (to: To | number, opts?: NavigateOptions) => void {
  const navigate = useNavigate();
  const env = useCurrentEnv();
  return useCallback(
    (to: To | number, opts?: NavigateOptions) => {
      if (typeof to === "number") navigate(to);
      else navigate(carry(to, env), opts);
    },
    [navigate, env],
  );
}

/** A hidden `env` field for GET forms, so submitting a filter form keeps the environment. */
export function EnvField() {
  const env = useCurrentEnv();
  return env ? <input type="hidden" name={ENV_PARAM} value={env} /> : null;
}

/** Remember the environment being viewed as this viewer's default for the organisation. */
export function useRememberEnv(orgId: string, env: string | null): void {
  useEffect(() => {
    if (!env) return;
    try {
      const memory = parseEnvCookie(readCookie(document.cookie, ENV_COOKIE));
      if (memory[orgId] === env) return;
      const secure = window.location.protocol === "https:" ? "; secure" : "";
      document.cookie = `${ENV_COOKIE}=${envCookieValue(memory, orgId, env)}; path=/; max-age=${ENV_COOKIE_MAX_AGE_S}; samesite=lax${secure}`;
    } catch {
      // cookies blocked: the URL still carries the choice
    }
  }, [orgId, env]);
}
