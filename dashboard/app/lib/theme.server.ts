import { createThemeSessionResolver } from "remix-themes";
import { createCookieSessionStorage } from "@remix-run/node";

const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "backwork_theme",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secrets: [process.env.THEME_SECRET || "backwork-theme-secret"],
    // secure only when actually served over https
    secure: process.env.NODE_ENV === "production",
  },
});

export const themeSessionResolver = createThemeSessionResolver(sessionStorage);
