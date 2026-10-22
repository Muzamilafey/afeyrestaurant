import { useRef } from 'react';
import { RECEIPT_CSS, receiptHtml, type ReceiptDoc } from '@/lib/printing';
import { cx } from './ui';

const PAPER_CSS = `
.rcpt-paper{-webkit-mask:linear-gradient(#000 0 0) top/100% calc(100% - 8px) no-repeat,radial-gradient(circle 5px at 50% 100%,#0000 98%,#000) bottom/12px 8px repeat-x;mask:linear-gradient(#000 0 0) top/100% calc(100% - 8px) no-repeat,radial-gradient(circle 5px at 50% 100%,#0000 98%,#000) bottom/12px 8px repeat-x}
/* Feeds out of the printer slot in short pulls, like a thermal printer, then settles. */
@keyframes rcpt-feed{
  0%{transform:translateY(-100%)}
  22%{transform:translateY(-74%)} 28%{transform:translateY(-73%)}
  48%{transform:translateY(-44%)} 54%{transform:translateY(-43%)}
  76%{transform:translateY(-14%)} 82%{transform:translateY(-13%)}
  100%{transform:translateY(0)}
}
.rcpt-feed{animation:rcpt-feed 2.2s cubic-bezier(.3,.7,.3,1) both}
@keyframes rcpt-shimmer{0%{opacity:.35}50%{opacity:1}100%{opacity:.35}}
.rcpt-led{animation:rcpt-shimmer 1s ease-in-out infinite}
.rcpt-led.done{animation:none;opacity:1}
@media (prefers-reduced-motion:reduce){.rcpt-feed{animation:none}.rcpt-led{animation:none}}
`;

/**
 * On-screen receipt that looks like the printed slip: white paper, torn bottom edge, same layout as the print.
 * With `animate`, it feeds out of a printer slot and scrolls down into view (once per receipt).
 */
export function ReceiptPaper({ doc, className, animate = false }: { doc?: ReceiptDoc | null; className?: string; animate?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  // Once printed, roll down to the total so the amount paid is what the cashier sees.
  const showTotal = () => {
    const el = scroller.current;
    if (el && el.scrollHeight > el.clientHeight) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };
  return (
    <div className={cx('rounded-2xl bg-page px-4 pb-4', animate ? 'pt-0' : 'pt-4', className)}>
      <style>{RECEIPT_CSS}{PAPER_CSS}</style>
      {animate && (
        <div className="relative z-10 mx-auto -mb-1 flex h-7 w-full max-w-[332px] items-center justify-end rounded-b-xl bg-gradient-to-b from-[#2a2f2c] to-[#161a18] px-3 shadow-lift" aria-hidden>
          <span className="absolute inset-x-3 bottom-1 h-[3px] rounded-full bg-black/70" />
          <span className={cx('rcpt-led h-1.5 w-1.5 rounded-full bg-brand', doc && 'done')} />
        </div>
      )}
      <div ref={scroller} className="max-h-80 overflow-y-auto overflow-x-hidden">
        {doc ? (
          <div key={doc.lines.length + (doc.copy ?? '')} className={cx('rcpt-paper mx-auto w-full max-w-[300px] bg-white px-4 pb-6 pt-4 shadow-lift', animate && 'rcpt-feed')} onAnimationEnd={animate ? showTotal : undefined}>
            <div className="rcpt" dangerouslySetInnerHTML={{ __html: receiptHtml(doc) }} />
          </div>
        ) : (
          <div className="mx-auto mt-2 h-10 w-full max-w-[300px] rounded-b bg-white/70" aria-label="Printing receipt" />
        )}
      </div>
    </div>
  );
}
