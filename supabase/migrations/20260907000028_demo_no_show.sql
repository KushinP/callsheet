-- ============================================================================
-- They booked and did not turn up.
--
-- A no-show is neither demo_completed nor lost. The demo did not happen, so
-- calling it complete is a lie the funnel would carry forever; but the deal is
-- not dead either — a no-show is the most reboookable state there is, and
-- filing it under Lost buries the list of people worth chasing tomorrow.
--
-- Placed after demo_booked so it reads where it happens. It is deliberately
-- NOT part of the forward chain in the app: booked → no-show → completed is
-- not a sequence anybody walks, and putting it there would make the funnel's
-- adjacent-stage ratios nonsense. It renders as a setback beside the chain,
-- with its own rate against demo_booked — which is the no-show rate, stated
-- rather than inferred from the gap.
--
-- Not terminal, so it can carry a playbook (chase the rebook) and moving into
-- it does not cancel open tasks.
-- ============================================================================

alter type public.pipeline_stage
  add value if not exists 'demo_no_show' after 'demo_booked';
