// The event catalogue (BAC-103). One place for every event name and the shape of its props, so no call
// site spells a name by hand. Props are flat, fixed vocabularies, plan slugs and booleans: never an
// email, a name, an id, a token, a path of a customer's or any text a person typed (BRIEF rule 4).
import type { Billing, PlanId } from "~/components/site/plans";

export type EventProp = string | number | boolean;

/** Events sent by the browser, only from backwork's own bare screens (see paths.ts). */
export enum ClientEvent {
  /** A "start free" or plan button on a public page was clicked. */
  CtaClicked = "cta_clicked",
  /** The embedded Inkress checkout reported a failed payment attempt. */
  CheckoutFrameFailed = "checkout_frame_failed",
}

/** Events sent by our server: facts the browser cannot see reliably. */
export enum ServerEvent {
  SignupCompleted = "signup_completed",
  SignupFailed = "signup_failed",
  LoginFailed = "login_failed",
  OrganizationCreated = "organization_created",
  ProjectCreated = "project_created",
  FirstDataReceived = "first_data_received",
  AlertCreated = "alert_created",
  TrialStarted = "trial_started",
  CheckoutOpened = "checkout_opened",
  SubscriptionStarted = "subscription_started",
  CheckoutFailed = "checkout_failed",
  RenewalDeclined = "renewal_declined",
  SubscriptionCancelled = "subscription_cancelled",
}

/** Where a call to action sits. */
export enum CtaLocation {
  Nav = "nav",
  MobileMenu = "mobile_menu",
  Hero = "hero",
  Footer = "footer",
  Docs = "docs",
  Pricing = "pricing",
}

export enum AuthMethod {
  Email = "email",
  Google = "google",
}

export enum SignupFailure {
  InvalidEmail = "invalid_email",
  WeakPassword = "weak_password",
  EmailTaken = "email_taken",
  RateLimited = "rate_limited",
}

export enum LoginFailure {
  InvalidCredentials = "invalid_credentials",
  RateLimited = "rate_limited",
  MissingFields = "missing_fields",
}

/** How soon after the project was made its first lines arrived (a time-to-value bucket). */
export enum FirstDataAge {
  UnderHour = "under_1h",
  UnderDay = "under_1d",
  UnderWeek = "under_7d",
}

export enum CheckoutFailureStage {
  /** The open checkout ended with no subscription: the payment was declined or the checkout abandoned. */
  Payment = "payment",
}

export interface ClientEventProps {
  [ClientEvent.CtaClicked]: { location: CtaLocation; plan?: PlanId };
  [ClientEvent.CheckoutFrameFailed]: { code: string; retryable: boolean };
}

type Empty = Record<string, never>;

export interface ServerEventProps {
  [ServerEvent.SignupCompleted]: { method: AuthMethod; plan_requested: boolean };
  [ServerEvent.SignupFailed]: { method: AuthMethod; reason: string };
  [ServerEvent.LoginFailed]: { method: AuthMethod; reason: string };
  [ServerEvent.OrganizationCreated]: { plan_requested: boolean };
  [ServerEvent.ProjectCreated]: { first: boolean };
  [ServerEvent.FirstDataReceived]: { after: FirstDataAge };
  [ServerEvent.AlertCreated]: { metric: string };
  [ServerEvent.TrialStarted]: { plan: PlanId };
  [ServerEvent.CheckoutOpened]: { plan: PlanId; billing: Billing };
  [ServerEvent.SubscriptionStarted]: { plan: PlanId; billing: Billing; after_trial: boolean };
  [ServerEvent.CheckoutFailed]: { stage: CheckoutFailureStage };
  [ServerEvent.RenewalDeclined]: Empty;
  [ServerEvent.SubscriptionCancelled]: Empty;
}

/** An event with its props, as billing and ingest hooks hand it over. */
export type ServerFact = { [E in ServerEvent]: { name: E; props: ServerEventProps[E]; dedupeKey?: string } }[ServerEvent];
