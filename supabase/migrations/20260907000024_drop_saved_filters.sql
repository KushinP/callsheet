-- ============================================================================
-- saved_filters never had a reader.
--
-- The table and its RLS policies were created on day one; the filter presets
-- shipped against localStorage instead and nothing ever wrote a row. The README
-- describes it as a "server-side mirror of the localStorage presets", which was
-- never true — and a table that lies about itself in the docs is worse than no
-- table, because the next person to read either believes it.
--
-- Presets therefore remain per-browser. That is a real limitation and worth
-- fixing one day, but by writing the feature, not by leaving an empty table
-- around implying it already exists.
-- ============================================================================

drop table if exists public.saved_filters;
