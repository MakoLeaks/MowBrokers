export type Plan = "Weekly" | "Every two weeks" | "One-time cut" | "No mowing";
export type RateCard = { mowTiers: number[]; biweeklyPremium: number; oneTimeMult: number; fertTiers: number[] | null; bundleDiscount: number; addons: { aeration: number | null; leafCleanup: number | null; shrubTrim: number | null } };
export type Extras = { referralCreditCents: number; prepayDiscount: number; respondHours: number; reviewAfterVisits: number };
export type Settings = {
  takeRate: number; roundTo: number; goalPairs: number; season: { weeks: number; label: string }; fertApps: number;
  lots: { label: string; min: number; scale: number }[]; terrains: { label: string; mult: number }[]; coverages: { label: string; mult: number }[]; suggested: RateCard; extras: Extras;
};
export type Spec = { acres: number; zip: string; terrain: string; coverage: string; plan: Plan; fert: boolean; aerate: boolean; leaves: boolean; shrubs: number; custom: string[] };
export type Quote = {
  tier: string; q: number; perVisit: number; visits: number; mowing: number; fertPerApp: number; fertApps: number; fert: number; bundle: number; fertVisit: number;
  aeration: number; leaves: number; shrubs: number; shrubVisit: number; annual: number; monthly: number; guideOnly: boolean; takeRate: number; prepay?: number; prepayDiscount?: number;
};
export type Vendor = {
  id: string; owner_id: string | null; slug: string; status: "applied" | "vetting" | "approved" | "suspended" | "rejected";
  business: string; contact: string; phone: string; email: string; years: number; techs: number; about: string; license: string; operator: string; categories: string[];
  insurance_carrier: string; insurance_coverage: number; insurance_expires: string; coi_path: string | null; zips: string[]; rate_card: RateCard; custom_jobs: string[];
  checklist: Record<string, boolean>; notes: string; stripe_account_id: string | null; stripe_charges_enabled: boolean; stripe_payouts_enabled: boolean; created_at: string; approved_at: string | null;
};
export type Booking = {
  id: string; ref: string; access_token: string; status: "pending_card" | "new" | "matched" | "scheduled" | "active" | "completed" | "cancelled"; chosen_by_customer: boolean;
  customer_name: string; customer_phone: string; customer_email: string | null; sms_consent: boolean; street: string; zip: string;
  yard: { acres: number; terrain: string; coverage: string }; plan: Plan; addons: { fert: boolean; aerate: boolean; leaves: boolean; shrubs: number }; custom: string[]; notes: string;
  preferred_start: string | null; first_visit: string | null; vendor_id: string | null; quote: (Quote & { takeRate: number }) | null;
  stripe_customer_id: string | null; stripe_payment_method_id: string | null; visits_charged: number; fert_charged: number;
  created_at: string; matched_at: string | null; nudged_at: string | null; scheduled_at: string | null; cancelled_at: string | null;
  visit_window: "morning" | "afternoon" | "any"; preferred_alt: string | null; respond_by: string | null; contacted_at: string | null;
  next_visit_due: string | null; service_year_start: string | null; paused_until: string | null; cancel_reason: string | null; cancelled_by: string | null;
  prepay: boolean; prepaid_through: string | null; prepay_payment_id: string | null; prepay_covers: Record<string, number> | null;
  credit_cents: number; referral_code: string | null; referred_by: string | null; review_requested_at: string | null; marketing_opt_out: boolean;
};
export type ItemKind = "visit" | "fert" | "aeration" | "leaves" | "shrubs";
export type Payment = {
  id: string; booking_id: string; vendor_id: string | null; kind: string; label: string; amount_cents: number; fee_cents: number; net_cents: number;
  status: "processing" | "succeeded" | "failed"; failure_message: string | null; stripe_payment_intent_id: string | null; stripe_charge_id: string | null;
  stripe_transfer_id: string | null; items: { kind: ItemKind; amount_cents: number }[]; discount_cents: number; refunded_cents: number; visit_id: string | null; attempts: number; created_at: string;
};
