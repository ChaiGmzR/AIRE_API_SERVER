-- Adds the production scope needed by the HxH report.
-- Existing rows remain NULL because their source application did not provide
-- line or flow information and must not be assigned retroactively.

ALTER TABLE box_scans
    ADD COLUMN production_type VARCHAR(16) NULL AFTER box_code,
    ADD COLUMN line_code VARCHAR(4) NULL AFTER production_type,
    ADD KEY idx_scope_time (production_type, line_code, first_scan);
        