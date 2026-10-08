-- A widget that frames a website.
--
-- This could not be done with the 'html' kind, and the reason is worth
-- recording. An html widget renders inside a srcdoc frame sandboxed WITHOUT
-- allow-same-origin, deliberately: that gives it a null origin so it cannot
-- reach the host page. Sandbox flags only ever narrow going down the frame
-- tree, so a site's own <iframe> nested inside that wrapper inherits the null
-- origin no matter what it asks for. The site then loads with no cookies and
-- no storage, and any page that touches localStorage while booting — which is
-- most of them, for a theme or a session — throws before it renders anything.
-- The result is a white rectangle with no error.
--
-- A framed site needs a frame of its own, at the site's real origin. Keeping
-- that a separate kind rather than sniffing URLs out of html is what lets the
-- renderer make that distinction safely.
alter table widgets drop constraint if exists widgets_kind_check;
alter table widgets add constraint widgets_kind_check
  check (kind in ('view', 'html', 'embed'));

-- Only ever http/https, enforced here as well as at the edge: a javascript:
-- or data: URL in a frame is script execution, and the activation gate is a
-- human reading a row, not a parser.
alter table widgets add column if not exists url text
  check (url is null or url ~* '^https?://');
