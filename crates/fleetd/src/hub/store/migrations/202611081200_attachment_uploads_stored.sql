-- The attachment an upload in pieces became (attachments.n), kept until the upload is swept: attachment_put sent again
-- with its uploadId, after its answer was lost, answers with that file rather than "No upload".
ALTER TABLE attachment_uploads ADD COLUMN stored_n INTEGER;
