-- ============================================================================
-- Demo booked and demo completed are different places to be.
--
-- One "Demo" stage conflated a promise with a delivery. The work between them
-- is the work that loses deals — a booked demo needs a reminder and a confirm;
-- a completed one needs a decision chased — and with one stage neither the
-- funnel nor a playbook could tell them apart.
--
-- Splitting it also puts a real number on the no-show rate, which is the
-- single most useful ratio in this pipeline and was previously invisible:
-- booked → completed.
--
-- RENAME rather than add-and-migrate. Every lead sitting in 'demo' today got
-- there by booking one, so 'demo_booked' is what that value already meant; a
-- rename carries them over with no data change and no window where the column
-- holds a value the app does not know.
-- ============================================================================

alter type public.pipeline_stage rename value 'demo' to 'demo_booked';

-- AFTER matters: workspace_funnel() orders by enum position, so a value added
-- at the end would render Demo completed past Paying.
alter type public.pipeline_stage add value if not exists 'demo_completed'
  after 'demo_booked';

-- The one existing playbook is named "after a demo" and its steps are a recap,
-- a nudge and a close — post-demo work. Under the old single stage it fired
-- whenever a rep decided a demo had happened; after the rename it would fire
-- the moment one was BOOKED, telling you to recap a demo that has not occurred.
-- Moving it preserves what it plainly meant.
update public.playbooks
   set trigger_stage = 'demo_completed'
 where trigger_stage = 'demo_booked'
   and name = 'Starter — after a demo';
