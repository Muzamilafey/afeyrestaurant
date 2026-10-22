import { RECEIPT_CSS, receiptHtml, type ReceiptDoc } from '@/lib/printing';
import { cx } from './ui';

/** On-screen receipt that looks like the printed slip: white paper, torn bottom edge, same layout as the print. */
export function ReceiptPaper({ doc, className }: { doc?: ReceiptDoc | null; className?: string }) {
  return (
    <div className={cx('max-h-80 overflow-auto rounded-2xl bg-page p-4', className)}>
      <style>{RECEIPT_CSS}{`.rcpt-paper{-webkit-mask:linear-gradient(#000 0 0) top/100% calc(100% - 8px) no-repeat,radial-gradient(circle 5px at 50% 100%,#0000 98%,#000) bottom/12px 8px repeat-x;mask:linear-gradient(#000 0 0) top/100% calc(100% - 8px) no-repeat,radial-gradient(circle 5px at 50% 100%,#0000 98%,#000) bottom/12px 8px repeat-x}`}</style>
      <div className="rcpt-paper mx-auto w-full max-w-[300px] bg-white px-4 pb-6 pt-4 shadow-lift">
        {doc ? <div className="rcpt" dangerouslySetInnerHTML={{ __html: receiptHtml(doc) }} /> : <div className="h-48 animate-pulse rounded bg-gray-100" />}
      </div>
    </div>
  );
}
