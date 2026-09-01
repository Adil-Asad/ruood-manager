/**
 * The small set of pieces every screen is built from.
 *
 * Nothing here knows about announcements. Anything that does belongs in a
 * screen, so that the day one of these grows a special case for "the publish
 * button" is a day it is obvious something is in the wrong file.
 */

import { useEffect, type ReactNode } from 'react';

import type { LifecycleStatus, ValidationIssue } from '@ruood/announcement-schema';

export function Card({ children }: { children: ReactNode }): JSX.Element {
  return <section className="card">{children}</section>;
}

export function Button({
  children,
  onClick,
  kind = 'default',
  disabled,
  small,
  title,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  small?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}): JSX.Element {
  const classes = ['btn', kind === 'default' ? '' : kind, small ? 'small' : ''].filter(Boolean);

  return (
    <button
      type={type}
      className={classes.join(' ')}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

/**
 * A labelled control, with the character budget beside the label.
 *
 * The count is shown always rather than on overflow, because a title has 60
 * characters and finding that out by being refused is worse than knowing.
 */
export function Field({
  label,
  hint,
  error,
  count,
  limit,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  count?: number;
  limit?: number;
  children: ReactNode;
}): JSX.Element {
  const over = count !== undefined && limit !== undefined && count > limit;

  return (
    <label className="field">
      <span className="label">
        <span>{label}</span>
        {count !== undefined && limit !== undefined ? (
          <span className={`counter${over ? ' over' : ''}`}>
            {count}/{limit}
          </span>
        ) : null}
      </span>
      {children}
      {hint ? <span className="field-note">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export function Badge({
  children,
  kind,
}: {
  children: ReactNode;
  kind?: LifecycleStatus | 'error';
}): JSX.Element {
  return <span className={`badge${kind ? ` ${kind}` : ''}`}>{children}</span>;
}

export function Callout({
  kind = 'info',
  title,
  children,
}: {
  kind?: 'info' | 'error' | 'warn' | 'ok';
  title?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className={`callout${kind === 'info' ? '' : ` ${kind}`}`}>
      {title ? <strong>{title}</strong> : null}
      {children}
    </div>
  );
}

export function Stat({ value, label }: { value: ReactNode; label: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

/**
 * Validation issues, rendered from their codes.
 *
 * The issue codes are a closed union in the schema rather than free text
 * specifically so a UI can key off them. The message is still what gets shown —
 * it is written for a person — but the code is displayed too, because it is what
 * matches the CLI's output when the same record is checked there.
 */
export function Issues({
  issues,
  severity,
}: {
  issues: readonly ValidationIssue[];
  severity: 'error' | 'warning';
}): JSX.Element | null {
  if (issues.length === 0) return null;

  return (
    <Callout
      kind={severity === 'error' ? 'error' : 'warn'}
      title={
        severity === 'error'
          ? `${issues.length} error${issues.length === 1 ? '' : 's'} — publishing is refused`
          : `${issues.length} warning${issues.length === 1 ? '' : 's'} — valid, but check them`
      }
    >
      <div>
        {issues.map((issue, index) => (
          <div className="issue" key={`${issue.code}-${issue.path}-${index}`}>
            {issue.path ? <span className="path">{issue.path}</span> : null}{' '}
            <span className="code">[{issue.code}]</span> {issue.message}
          </div>
        ))}
      </div>
    </Callout>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  actions,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}): JSX.Element {
  // Escape closes. Nothing in this tool may produce a dialog a person cannot
  // get out of — the same rule the announcement contract enforces on the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        <div className="actions">{actions}</div>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>;
}
