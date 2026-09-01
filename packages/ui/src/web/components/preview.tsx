/**
 * What the announcement will roughly look like in RUOOD Lab.
 *
 * **Approximate, and it says so on screen.** It is a DOM rendering of tokens
 * copied from a React Native app; the fonts, the safe-area insets and the
 * platform's own dialog chrome are not reproduced and cannot be. What it is
 * good for is the question an operator actually has — does this title fit, does
 * this body run to six lines, does the image crop badly — and for those it is
 * honest.
 *
 * Four frames, always: 360 and 430 CSS pixels, light and dark. 360 is the
 * narrow phone where text overflows first and 430 is the wide one; an operator
 * authors once and every user sees it in whichever theme they have set, so
 * showing one and hoping is how a body that reads fine in light comes out
 * unreadable in dark.
 *
 * Nothing here renders markup. Body text is set as text, never as HTML — the
 * validator refuses angle brackets so that stored text can never read as
 * markup, and a preview that undid that would be the one place it was false.
 */

import type { AuthoredAnnouncement } from '@ruood/announcement-schema';

const WIDTHS = [360, 430] as const;
const THEMES = ['light', 'dark'] as const;

export function Preview({
  record,
  imageUrl,
}: {
  record: AuthoredAnnouncement;
  imageUrl: string | null;
}): JSX.Element {
  return (
    <>
      <div className="spread">
        <div>
          <h2>Preview</h2>
          <p className="hint">
            Approximate. Real fonts, safe-area insets and the platform's own dialog chrome are
            not reproduced — this is for length, wrapping and how the image crops.
          </p>
        </div>
      </div>

      <div className="preview-grid">
        {WIDTHS.map((width) =>
          THEMES.map((theme) => (
            <div key={`${width}-${theme}`}>
              <div className="ruood-frame-label">
                {width}px · {theme}
              </div>
              <div className={`ruood-frame ruood ${theme}`} style={{ width }}>
                <Surface record={record} imageUrl={imageUrl} />
              </div>
            </div>
          )),
        )}
      </div>
    </>
  );
}

function Surface({
  record,
  imageUrl,
}: {
  record: AuthoredAnnouncement;
  imageUrl: string | null;
}): JSX.Element {
  const { surface } = record.display;

  if (surface === 'modal') {
    return (
      <div className="ruood-screen modal-context">
        <div className="ruood-card">
          {imageUrl ? (
            <img className="ruood-image" src={imageUrl} alt={record.image?.alt ?? ''} />
          ) : null}
          <h3 className="ruood-title">{record.title}</h3>
          <p className="ruood-body">{record.body}</p>
          <div className="ruood-actions">
            {/*
             * A close affordance is always drawn. `dismiss: 'none'` never means
             * "cannot be closed" — nothing in this contract may produce a dialog
             * a user cannot get out of, and the preview should not suggest
             * otherwise.
             */}
            <button className="ruood-dismiss" tabIndex={-1}>
              {dismissLabel(record.display.dismiss)}
            </button>
            {record.action ? (
              <button className="ruood-action" tabIndex={-1}>
                {record.action.label}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (surface === 'banner') {
    return (
      <div className="ruood-screen">
        <div className="ruood-banner">
          {imageUrl ? (
            <img className="ruood-banner-thumb" src={imageUrl} alt={record.image?.alt ?? ''} />
          ) : null}
          <div style={{ minWidth: 0 }}>
            <h3 className="ruood-title">{record.title}</h3>
            <p className="ruood-body">{record.body}</p>
            {record.action ? (
              <button className="ruood-action" tabIndex={-1}>
                {record.action.label}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // inbox — Settings › Announcements. Never presented; only ever found.
  return (
    <div className="ruood-screen">
      <div className="ruood-inbox-row">
        <h3 className="ruood-title">{record.title}</h3>
        <p className="ruood-body">{record.body}</p>
      </div>
    </div>
  );
}

function dismissLabel(dismiss: AuthoredAnnouncement['display']['dismiss']): string {
  switch (dismiss) {
    case 'permanent':
      return 'Dismiss';
    case 'session':
      return 'Not now';
    case 'snooze-24h':
      return 'Later';
    case 'none':
      return 'Close';
  }
}
