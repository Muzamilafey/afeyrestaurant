import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Utensils, Beef, Salad, Sandwich, CupSoda, Beer, Martini as MartiniIcon, Wine, Pizza, Coffee, IceCream, Fish, Soup, Cake, Croissant, Drumstick, Egg, Apple, Citrus, GlassWater, LayoutGrid, Users, type LucideIcon, Search, ScanBarcode, Trash2, Minus, Plus, Send, PauseCircle, PlayCircle, ArrowRightLeft, Merge, Split, Printer, Percent, Ban, UtensilsCrossed, ShoppingBag, Bike, Martini, ChefHat, StickyNote, UserRound, CloudOff } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { useFeedback } from '@/components/feedback';
import { Button, Input, Modal, Pill, Select, Skeleton, StatusPill, cx, Empty, Field } from '@/components/ui';
import { ApiError, get, post, patch } from '@/lib/api';
import { money, uuid, toCents } from '@/lib/format';
import { cacheCatalog, cachedCatalog, queueOfflineOrder, terminalId } from '@/lib/offline';
import { printReceipt, type ReceiptDoc } from '@/lib/printing';
import { useOnline } from '@/lib/connectivity';
import { OfflinePayDialog, type OfflinePayment } from './OfflinePayDialog';
import { AssignRiderDialog, type DeliveryDetails } from './AssignRiderDialog';
import { SoldOutDialog } from '@/components/SoldOutDialog';
import { ProductCard } from './ProductCard';
import { ModifierDialog } from './ModifierDialog';
import { PaymentDialog, ReceiptPanel } from './PaymentDialog';
import type { Catalog, DraftLine, Order, Product } from './types';

const KIND_FILTERS = [
  { id: 'all', label: 'All' }, { id: 'food', label: 'Food' }, { id: 'soft_drink', label: 'Soft drinks' }, { id: 'alcohol', label: 'Alcoholic' },
  { id: 'cocktail', label: 'Cocktails' }, { id: 'beer', label: 'Beer' }, { id: 'wine', label: 'Wine' }, { id: 'spirit', label: 'Spirits' }, { id: 'other', label: 'Other' },
];
const ALCOHOL = ['alcohol', 'cocktail', 'beer', 'wine', 'spirit'];
const MODES = [
  { id: 'dine_in', label: 'Dine-in', icon: UtensilsCrossed },
  { id: 'takeaway', label: 'Takeaway', icon: ShoppingBag },
  { id: 'delivery', label: 'Delivery', icon: Bike },
  { id: 'bar_counter', label: 'Bar', icon: Martini },
] as const;

/** Curated category icons (importing the whole icon set would bloat the POS bundle). */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  utensils: Utensils, beef: Beef, salad: Salad, sandwich: Sandwich, 'cup-soda': CupSoda, beer: Beer, martini: MartiniIcon, wine: Wine, pizza: Pizza, coffee: Coffee,
  'ice-cream': IceCream, fish: Fish, soup: Soup, cake: Cake, croissant: Croissant, drumstick: Drumstick, egg: Egg, apple: Apple, citrus: Citrus, 'glass-water': GlassWater, 'layout-grid': LayoutGrid,
};
export const CATEGORY_ICON_NAMES = Object.keys(CATEGORY_ICONS);
function CategoryIcon({ name, className }: { name: string; className?: string }) {
  const I = CATEGORY_ICONS[name] ?? Utensils;
  return <I className={className} />;
}

export type Outlet = 'restaurant' | 'bar';
/** Service modes offered on each POS (further limited by the branch's enabled modes). The first one is the default. */
const OUTLET_MODES: Record<Outlet, string[]> = { restaurant: ['dine_in', 'takeaway', 'delivery'], bar: ['bar_counter', 'dine_in', 'takeaway'] };

interface TablesResp { tables: Array<{ _id: string; number: string; status: string; capacity: number; orders: Array<{ id: string; number: string; outlet?: Outlet; waiterName?: string; total: number; itemCount: number }>; itemCount: number; progress: number }>; takeaway: Array<{ id: string; number: string; type: string; outlet?: Outlet; status: string; waiterName?: string; total: number; itemCount: number; progress: number }> }

/**
 * Point of sale. The restaurant and the bar each have their own POS (/pos and /bar-pos): its own part of the menu,
 * service modes and open orders. Orders remember which POS took them, for the open-order lists and sales reports.
 */
export default function PosPage({ outlet = 'restaurant' }: { outlet?: Outlet }) {
  const { branch, session, can } = useAuth();
  const { toast, handleError, withApproval, confirm , prompt } = useFeedback();
  const qc = useQueryClient();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const branchId = branch?.id ?? '';

  // ── Catalogue with offline fallback ──
  const [offlineCatalog, setOfflineCatalog] = useState<{ savedAt: string; data: Catalog } | null>(null);
  const catalogQ = useQuery<Catalog>({
    queryKey: ['catalog', branchId],
    queryFn: async () => {
      const c = await get<Catalog>('/menu/catalog');
      cacheCatalog(branchId, c).catch(() => undefined);
      return c;
    },
    enabled: !!branchId,
    refetchInterval: 60_000,
    retry: 1,
  });
  useEffect(() => {
    if (catalogQ.isError && branchId) cachedCatalog<Catalog>(branchId).then(setOfflineCatalog);
  }, [catalogQ.isError, branchId]);
  const catalog = catalogQ.data ?? offlineCatalog?.data;
  const usingCache = !catalogQ.data && !!offlineCatalog;

  const tablesQ = useQuery<TablesResp>({ queryKey: ['tables', branchId], queryFn: () => get('/tables'), enabled: !!branchId && online, refetchInterval: 20_000 });

  // ── Current order: either a local draft or a server order ──
  const orderId = params.get('order');
  const orderQ = useQuery<{ order: Order }>({ queryKey: ['order', orderId], queryFn: () => get(`/orders/${orderId}`), enabled: !!orderId });
  const order = orderQ.data?.order ?? null;
  const modes = useMemo(() => {
    const enabled = (branch?.settings?.enabledModes as string[] | undefined) ?? ['dine_in', 'takeaway', 'delivery', 'bar_counter'];
    const list = OUTLET_MODES[outlet].filter((m) => enabled.includes(m));
    return list.length ? list : ['takeaway'];
  }, [branch, outlet]);
  const [mode, setMode] = useState<string>(() => modes[0]);
  // Switching between the restaurant and bar POS (same page component): reset to that POS's default mode.
  useEffect(() => { setMode(modes[0]); }, [outlet]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Off: only this POS's part of the menu (bar = categories prepared at the bar). On: the whole menu. */
  const [fullMenu, setFullMenu] = useState(false);
  const [soldOutOpen, setSoldOutOpen] = useState(false);
  useEffect(() => { setFullMenu(false); setCategory('all'); setKind('all'); }, [outlet]);
  const [tableId, setTableId] = useState<string>(params.get('table') ?? '');
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [kind, setKind] = useState('all');
  const [q, setQ] = useState('');
  const [modFor, setModFor] = useState<Product | null>(null);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'transfer' | 'merge' | 'split' | 'held' | 'customer'>(null);
  /** Dine-in without a table: ask for one, then carry on with the action that was pressed. */
  const [pickTableFor, setPickTableFor] = useState<null | 'send' | 'pay'>(null);
  /** Delivery: confirm the address and assign a rider before the order is placed. */
  const [pickRiderFor, setPickRiderFor] = useState<null | 'send' | 'pay'>(null);
  const [offlineReceipt, setOfflineReceipt] = useState<Order | null>(null);
  // Phones: the order panel is a full-screen sheet opened from a floating button.
  const [showCart, setShowCart] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (params.get('pay') === '1' && order && ['open', 'held'].includes(order.status)) {
      setPaying(true);
      const next = new URLSearchParams(params);
      next.delete('pay');
      setParams(next, { replace: true });
    }
  }, [params, order]);

  useEffect(() => {
    const t = params.get('table');
    if (t && !orderId) {
      setTableId(t);
      setMode('dine_in');
    }
  }, [params, orderId]);

  const categoriesById = useMemo(() => new Map(catalog?.categories.map((c) => [c._id, c]) ?? []), [catalog]);
  const inOutlet = (categoryId: string) => (categoriesById.get(categoryId)?.station === 'bar') === (outlet === 'bar');
  const outletProducts = useMemo(() => (catalog?.products ?? []).filter((p) => fullMenu || inOutlet(p.categoryId)), [catalog, fullMenu, outlet, categoriesById]); // eslint-disable-line react-hooks/exhaustive-deps
  const outletCategories = useMemo(() => (catalog?.categories ?? []).filter((c) => outletProducts.some((p) => p.categoryId === c._id)), [catalog, outletProducts]);
  const soldOutCount = (catalog?.products ?? []).filter((p) => p.status === 'sold_out').length;
  const kindFilters = KIND_FILTERS.filter((k) => k.id === 'all' || outletProducts.some((p) => { const ck = categoriesById.get(p.categoryId)?.kind ?? ''; return k.id === 'alcohol' ? ALCOHOL.includes(ck) : ck === k.id; }));
  const products = useMemo(() => {
    if (!catalog) return [];
    const term = q.trim().toLowerCase();
    return outletProducts.filter((p) => {
      const c = categoriesById.get(p.categoryId);
      if (category !== 'all' && p.categoryId !== category) return false;
      if (kind !== 'all' && !(kind === 'alcohol' ? ALCOHOL.includes(c?.kind ?? '') : c?.kind === kind)) return false;
      if (term && !(p.name.toLowerCase().includes(term) || p.sku?.toLowerCase() === term || p.barcode === term || p.plu === term)) return false;
      return true;
    });
  }, [outletProducts, category, kind, q, categoriesById]);

  const setOrder = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('order', id);
    else next.delete('order');
    next.delete('table');
    setParams(next, { replace: true });
  };
  const resetDraft = () => {
    setDraft([]);
    setCustomerName('');
    setCustomerPhone('');
    setDeliveryAddress('');
    setTableId('');
  };

  const stationFor = (p: Product) => categoriesById.get(p.categoryId)?.station ?? 'kitchen';
  const qtyInCart = (pid: string) => (order ? order.items.filter((i) => i.productId === pid && !i.voided && i.status === 'new').reduce((s, i) => s + i.qty, 0) : draft.filter((d) => d.productId === pid).reduce((s, d) => s + d.qty, 0));

  async function addLine(line: DraftLine) {
    if (!order) {
      setDraft((d) => {
        const same = d.find((x) => x.productId === line.productId && !x.modifiers.length && !line.modifiers.length && !x.notes && !line.notes && x.variant === line.variant);
        return same ? d.map((x) => (x === same ? { ...x, qty: x.qty + line.qty } : x)) : [...d, line];
      });
      return;
    }
    try {
      await withApproval((approval) => post(`/orders/${order._id}/items`, { items: [{ productId: line.productId, qty: line.qty, variant: line.variant, modifiers: line.modifiers.map(({ groupId, optionId }) => ({ groupId, optionId })), notes: line.notes, lineId: line.lineId, ageCheckConfirmed: line.ageCheckConfirmed }], approval }));
      qc.invalidateQueries({ queryKey: ['order', order._id] });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK') {
        const shortages = (e.details as { shortages: Array<{ name: string }> }).shortages.map((s) => s.name).join(', ');
        const c = await confirm({ title: 'Insufficient stock', message: `Not enough ${shortages}. Sell anyway with manager override?`, reason: true, confirmLabel: 'Override' });
        if (c.ok) {
          try {
            await withApproval((approval) => post(`/orders/${order._id}/items`, { items: [{ productId: line.productId, qty: line.qty, variant: line.variant, modifiers: line.modifiers.map(({ groupId, optionId }) => ({ groupId, optionId })), notes: line.notes, lineId: line.lineId, ageCheckConfirmed: line.ageCheckConfirmed }], overrideStockReason: c.reason, approval }));
            qc.invalidateQueries({ queryKey: ['order', order._id] });
          } catch (err) {
            handleError(err);
          }
        }
      } else handleError(e);
    }
  }

  function quickAdd(p: Product) {
    if (p.modifierGroupIds.length || p.variants.length || p.ageRestricted) return setModFor(p);
    addLine({ lineId: uuid(), productId: p._id, name: p.name, qty: 1, unitPrice: p.currentPrice, modifiers: [], station: stationFor(p) });
  }
  async function dec(p: Product) {
    if (!order) {
      setDraft((d) => {
        const idx = [...d].reverse().findIndex((x) => x.productId === p._id);
        if (idx < 0) return d;
        const i = d.length - 1 - idx;
        return d[i].qty > 1 ? d.map((x, j) => (j === i ? { ...x, qty: x.qty - 1 } : x)) : d.filter((_, j) => j !== i);
      });
      return;
    }
    const line = [...order.items].reverse().find((i) => i.productId === p._id && i.status === 'new' && !i.voided);
    if (line) await changeQty(line.lineId, line.qty - 1);
  }
  async function changeQty(lineId: string, qty: number) {
    if (!order) {
      setDraft((d) => (qty <= 0 ? d.filter((x) => x.lineId !== lineId) : d.map((x) => (x.lineId === lineId ? { ...x, qty } : x))));
      return;
    }
    try {
      if (qty <= 0) await post(`/orders/${order._id}/items/${lineId}/void`, { reason: 'Removed before sending' });
      else await patch(`/orders/${order._id}/items/${lineId}`, { qty });
      qc.invalidateQueries({ queryKey: ['order', order._id] });
    } catch (e) {
      handleError(e);
    }
  }
  async function voidLine(lineId: string, name: string) {
    if (!order) return changeQty(lineId, 0);
    const c = await confirm({ title: `Void ${name}?`, message: 'Voids are recorded with your name and reason. Items already sent to the kitchen/bar need manager approval.', reason: true, danger: true, confirmLabel: 'Void item' });
    if (!c.ok) return;
    try {
      await withApproval((approval) => post(`/orders/${order._id}/items/${lineId}/void`, { reason: c.reason, approval }));
      qc.invalidateQueries({ queryKey: ['order', order._id] });
      toast('Item voided');
    } catch (e) {
      handleError(e);
    }
  }

  /** Create the order on the server from the draft (idempotent by clientId). */
  const draftClientId = useRef(uuid());
  async function createFromDraft(send: boolean, table = tableId, delivery?: DeliveryDetails): Promise<Order | null> {
    if (mode === 'dine_in' && !table) {
      toast('Select a table for dine-in orders', 'error');
      return null;
    }
    const items = draft.map((d) => ({ productId: d.productId, qty: d.qty, variant: d.variant, modifiers: d.modifiers.map(({ groupId, optionId }) => ({ groupId, optionId })), notes: d.notes, lineId: d.lineId, ageCheckConfirmed: d.ageCheckConfirmed }));
    const name = delivery?.customerName ?? customerName;
    const phone = delivery?.customerPhone ?? customerPhone;
    const body = { clientId: draftClientId.current, type: mode, outlet, tableId: mode === 'dine_in' ? table : undefined, customerName: name || undefined, customerPhone: phone || undefined, delivery: mode === 'delivery' ? { address: delivery?.address ?? deliveryAddress, riderId: delivery?.riderId } : undefined, items, sendToStations: send };
    const o = await withApproval((approval) => post<Order>('/orders', { ...body, approval }));
    draftClientId.current = uuid();
    resetDraft();
    setOrder(o._id);
    qc.setQueryData(['order', o._id], { order: o });
    qc.invalidateQueries({ queryKey: ['tables'] });
    return o;
  }

  const needsTable = () => !order && online && mode === 'dine_in' && !tableId;
  const needsRider = (delivery?: DeliveryDetails) => !order && online && mode === 'delivery' && !delivery;

  async function placeOrder(table = tableId, delivery?: DeliveryDetails) {
    if (table === tableId && needsTable()) return setPickTableFor('send');
    if (needsRider(delivery)) return setPickRiderFor('send');
    setBusy('send');
    try {
      let sent: string | null = null;
      if (!order) {
        const o = await createFromDraft(true, table, delivery);
        if (o) sent = `Order ${o.number} sent${o.delivery?.riderName ? ` · rider ${o.delivery.riderName}` : ''}`;
      } else {
        const r = await post<{ order: Order; tickets: unknown[] }>(`/orders/${order._id}/send`, { submissionKey: uuid() });
        qc.setQueryData(['order', order._id], (old: { order: Order } | undefined) => ({ ...(old ?? {}), order: r.order }));
        if (r.tickets.length) sent = `${order.number} sent to kitchen/bar`;
        else toast('Nothing new to send');
      }
      // Sent: start a fresh order straight away. The sent one stays open in the strip below (tap it to add or pay).
      if (sent) {
        setOrder(null);
        resetDraft();
        qc.invalidateQueries({ queryKey: ['tables'] });
        toast(`${sent} · new order started`);
      }
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  async function startPayment(table = tableId, delivery?: DeliveryDetails) {
    if (!online) return payOffline();
    if (table === tableId && needsTable()) return setPickTableFor('pay');
    if (needsRider(delivery)) return setPickRiderFor('pay');
    if (!order) {
      setBusy('pay');
      try {
        const o = await createFromDraft(true, table, delivery);
        if (o) setPaying(true);
      } catch (e) {
        // The connection dropped before the till noticed: carry on as an offline sale instead of failing.
        if (e instanceof ApiError && e.code === 'NETWORK') void payOffline();
        else handleError(e);
      } finally {
        setBusy(null);
      }
      return;
    }
    setPaying(true);
  }

  /** Offline: open the offline payment window (cash, card or M-Pesa code); the sale syncs when the connection returns. */
  const offlineActions: string[] = session?.business?.settings?.offlineAllowedActions ?? ['create_order', 'cash_payment', 'card_payment', 'mpesa_payment'];
  const offlineAllowed = { cash: offlineActions.includes('cash_payment'), card: offlineActions.includes('card_payment'), mpesa: offlineActions.includes('mpesa_payment') };
  const [offlinePay, setOfflinePay] = useState(false);
  async function payOffline() {
    if (order) return toast('This order lives on the server. Reconnect to take payment.', 'error');
    if (!offlineActions.includes('create_order') || !(offlineAllowed.cash || offlineAllowed.card || offlineAllowed.mpesa)) return toast('Offline sales are switched off in Settings → Business', 'error');
    setOfflinePay(true);
  }
  async function recordOfflineSale(p: OfflinePayment) {
    setOfflinePay(false);
    const total = draft.reduce((s, d) => s + d.unitPrice * d.qty, 0);
    const clientId = uuid();
    const createdAt = new Date().toISOString();
    const type = mode === 'bar_counter' ? 'bar_counter' : mode === 'dine_in' && tableId ? 'dine_in' : 'takeaway';
    const tableNo = tables.find((t) => t._id === tableId)?.number;
    await queueOfflineOrder(branchId, {
      clientId, terminalId: terminalId(), createdAt, type, outlet, tableId: mode === 'dine_in' ? tableId || undefined : undefined, customerName: customerName || undefined,
      items: draft.map((d) => ({ lineId: d.lineId, productId: d.productId, qty: d.qty, variant: d.variant, modifiers: d.modifiers.map(({ groupId, optionId }) => ({ groupId, optionId })), notes: d.notes, unitPrice: d.unitPrice, name: d.name })),
      payments: [{ clientPaymentId: uuid(), method: p.method, amount: total, tendered: p.tendered, reference: p.reference, phone: p.phone }],
    });
    const amt = (c: number) => (c / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ref = clientId.slice(0, 8).toUpperCase();
    const when = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const service = `${type === 'dine_in' ? 'Dine in' : type === 'bar_counter' ? 'Bar' : 'Takeaway'}${tableNo ? ` - Table ${tableNo}` : ''}`;
    const payRows: ReceiptDoc['lines'] =
      p.method === 'cash'
        ? [{ k: 'row', l: 'Cash', r: amt(total), bold: true }, ...((p.tendered ?? total) > total ? [{ k: 'row' as const, l: '  Cash given', r: amt(p.tendered!), muted: true }, { k: 'row' as const, l: '  Change', r: amt(p.tendered! - total), muted: true }] : [])]
        : p.method === 'card'
          ? [{ k: 'row', l: `Card${p.reference ? ` ${p.reference}` : ''}`, r: amt(total), bold: true }]
          : [{ k: 'row', l: `M-Pesa ${p.reference}`, r: amt(total), bold: true }, { k: 'row', l: '  (being confirmed with M-Pesa)', r: '', muted: true }];
    const receipt: ReceiptDoc = {
      kind: 'receipt',
      copy: 'original',
      lines: [
        ...(session?.business?.branding?.logoUrl ? [{ k: 'logo' as const, url: session.business.branding.logoUrl }] : []),
        { k: 'title', t: (session?.business?.name ?? 'Chili POS').toUpperCase() },
        ...(branch?.name ? [{ k: 'center' as const, t: branch.name, bold: true }] : []),
        { k: 'rule', heavy: true },
        { k: 'banner', t: 'OFFLINE SALE - PENDING SYNC' },
        { k: 'row', l: 'Reference', r: ref },
        { k: 'row', l: 'Date', r: when },
        { k: 'row', l: 'Service', r: service },
        { k: 'rule' },
        ...draft.map((d) => ({ k: 'item' as const, qty: d.qty, name: d.name, total: amt(d.unitPrice * d.qty), each: d.qty > 1 ? amt(d.unitPrice) : undefined, mods: d.modifiers.map((m) => m.name) })),
        { k: 'rule', heavy: true },
        { k: 'row', l: 'TOTAL', r: `KSh ${amt(total)}`, bold: true, big: true },
        ...payRows,
        { k: 'rule' },
        { k: 'center', t: 'Official receipt number issued once the sale syncs.', muted: true },
        { k: 'center', t: 'Powered by Chili POS', muted: true },
      ],
    };
    // The kitchen/bar screens can't receive the order while offline, so print their tickets on this till.
    const tickets: ReceiptDoc[] = p.printTickets
      ? (['kitchen', 'bar'] as const)
          .map((station) => ({ station, items: draft.filter((d) => d.station === station) }))
          .filter((g) => g.items.length)
          .map((g) => ({
            kind: 'receipt' as const,
            copy: 'original' as const,
            lines: [
              { k: 'title' as const, t: g.station === 'kitchen' ? 'KITCHEN' : 'BAR' },
              { k: 'banner' as const, t: 'OFFLINE ORDER' },
              { k: 'row' as const, l: service, r: when.split(', ').pop() ?? '' },
              { k: 'row' as const, l: 'Ref', r: ref },
              ...(customerName ? [{ k: 'row' as const, l: 'Customer', r: customerName }] : []),
              { k: 'rule' as const, heavy: true },
              ...g.items.map((d) => ({ k: 'item' as const, qty: d.qty, name: d.name, total: '', mods: [...d.modifiers.map((m) => m.name), ...(d.notes ? [`NOTE: ${d.notes}`] : [])] })),
              { k: 'rule' as const },
            ],
          }))
      : [];
    setOfflineReceipt({ _id: clientId, number: ref, totals: { total } } as Order);
    resetDraft();
    try {
      printReceipt([receipt, ...tickets], 'Offline sale');
    } catch {
      /* printing is optional */
    }
    toast(p.method === 'mpesa' ? 'Offline M-Pesa sale saved — the code is confirmed when the connection returns' : 'Offline sale saved — it uploads automatically when the connection returns');
  }


  async function action(name: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(name);
    try {
      await fn();
      if (success) toast(success);
      qc.invalidateQueries({ queryKey: ['order'] });
      qc.invalidateQueries({ queryKey: ['tables'] });
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  async function discount() {
    if (!order) return toast('Place the order first, then apply a discount', 'info');
    const pct = await prompt({ title: 'Discount', label: 'Discount % or coupon code', defaultValue: '10', hint: 'Enter 0 to remove the discount.', confirmLabel: 'Apply' });
    if (pct === null) return;
    const isCoupon = /[a-z]/i.test(pct);
    const c = isCoupon ? { ok: true, reason: undefined } : Number(pct) === 0 ? { ok: true, reason: undefined } : await confirm({ title: `Apply ${pct}% discount`, message: 'Discounts above the threshold need manager approval.', reason: true });
    if (!c.ok) return;
    await action('discount', () => withApproval((approval) => post(`/orders/${order._id}/discount`, isCoupon ? { type: 'none', value: 0, couponCode: pct, approval } : { type: Number(pct) ? 'percent' : 'none', value: Number(pct), reason: c.reason, approval })), 'Discount updated');
  }

  async function printBill() {
    if (!order) return;
    const r = await get<{ doc: ReceiptDoc }>(`/orders/${order._id}/receipt`).catch(handleError);
    if (r) printReceipt(r.doc, 'Bill');
  }

  // Barcode scanners type the code and press Enter.
  function onSearchEnter() {
    const term = q.trim();
    if (!term || !catalog) return;
    const hit = catalog.products.find((p) => p.barcode === term || p.sku?.toLowerCase() === term.toLowerCase() || p.plu === term);
    if (hit) {
      if (hit.available) quickAdd(hit);
      else toast(`${hit.name} is unavailable`, 'error');
      setQ('');
    }
  }

  const lines = order ? order.items.filter((i) => !i.voided) : draft;
  const draftTotal = draft.reduce((s, d) => s + d.unitPrice * d.qty, 0);
  const svcBps = (branch?.settings?.serviceChargeBps as number) ?? 0;
  const estService = mode === 'dine_in' && (branch?.settings?.serviceChargeModes as string[] | undefined ?? ['dine_in']).includes('dine_in') ? Math.round((draftTotal * svcBps) / 10000) : 0;
  const hasNew = order ? order.items.some((i) => i.status === 'new' && !i.voided) : draft.length > 0;
  const tables = tablesQ.data?.tables ?? [];
  // Only this POS's open orders (the restaurant and the bar each see their own).
  const activeChips = [...tables.filter((t) => t.orders.length).flatMap((t) => t.orders.map((o) => ({ ...o, table: t.number, progress: t.progress }))), ...(tablesQ.data?.takeaway ?? []).map((o) => ({ ...o, table: o.type === 'delivery' ? 'DLV' : o.type === 'bar_counter' ? 'BAR' : 'TA' }))]
    .filter((o) => (o.outlet ?? 'restaurant') === outlet);
  const locked = order && !['open', 'held'].includes(order.status);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* ── Product workspace ── */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-card px-4 py-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
              <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSearchEnter()} placeholder="Search menu, SKU, PLU or scan barcode…" className="pl-9 pr-10" aria-label="Search products" />
              <ScanBarcode className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
            </div>
            <div className="scroll-thin flex gap-1 overflow-x-auto">
              <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-bold', outlet === 'bar' ? 'bg-info-pale text-info' : 'bg-brand-pale text-brand-dark')}>
                {outlet === 'bar' ? <Martini className="h-3.5 w-3.5" /> : <UtensilsCrossed className="h-3.5 w-3.5" />} {outlet === 'bar' ? 'Bar POS' : 'Restaurant POS'}
              </span>
              {kindFilters.map((k) => (
                <button key={k.id} onClick={() => setKind(k.id)} className={cx('whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold', kind === k.id ? 'bg-ink text-card' : 'bg-page text-ink-soft hover:text-ink')}>{k.label}</button>
              ))}
              {can('menu.manage', 'kitchen.update', 'bar.update', 'orders.update') && (
                <button onClick={() => setSoldOutOpen(true)} title="Mark items sold out / back on sale" className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:text-ink">
                  <Ban className="h-3.5 w-3.5" /> Sold out{soldOutCount ? ` · ${soldOutCount}` : ''}
                </button>
              )}
              <button onClick={() => { setFullMenu(!fullMenu); setCategory('all'); setKind('all'); }} aria-pressed={fullMenu} title={outlet === 'bar' ? 'Also show food and other items' : 'Also show drinks made at the bar'} className={cx('whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold', fullMenu ? 'border-ink bg-ink text-card' : 'border-line text-ink-soft hover:text-ink')}>
                {fullMenu ? 'Full menu ✓' : 'Full menu'}
              </button>
            </div>
          </div>
          {usingCache && (
            <div className="flex items-center gap-2 bg-warn-pale px-4 py-2 text-xs text-warn-ink"><CloudOff className="h-4 w-4" /> Showing the menu cached at {new Date(offlineCatalog!.savedAt).toLocaleString()}. Prices and stock may have changed.</div>
          )}
          <div className="scroll-thin flex gap-3 overflow-x-auto px-4 py-3">
            <CategoryCard active={category === 'all'} onClick={() => setCategory('all')} icon="layout-grid" name="All items" count={outletProducts.length} />
            {outletCategories.map((c) => <CategoryCard key={c._id} active={category === c._id} onClick={() => setCategory(c._id)} icon={c.icon} name={c.name} count={outletProducts.filter((p) => p.categoryId === c._id).length} />)}
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {!catalog ? (
              catalogQ.isError ? <Empty title="Menu unavailable" hint="The server is unreachable and no cached menu exists on this terminal yet." /> : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-56" />)}</div>
              )
            ) : products.length === 0 ? (
              <Empty title="No products match" hint="Try another category or search term." />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {products.map((p) => <ProductCard key={p._id} product={p} kind={categoriesById.get(p.categoryId)?.kind ?? 'other'} qtyInCart={qtyInCart(p._id)} onAdd={() => quickAdd(p)} onDec={() => dec(p)} />)}
              </div>
            )}
          </div>
        </section>

        {/* ── Order & checkout panel ── */}
        <aside className={cx('flex-col border-l border-line bg-card md:flex md:w-[330px] md:shrink-0 xl:w-[400px]', showCart ? 'fixed inset-0 z-30 flex' : 'hidden')}>
          <button className="flex items-center justify-between border-b border-line px-4 py-3 text-sm font-semibold md:hidden" onClick={() => setShowCart(false)}>← Back to menu</button>
          <div className="border-b border-line p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase text-ink-soft">{order ? 'Order' : 'New order'}</p>
                <p className="text-lg font-bold">{order ? order.number : 'Draft'}</p>
              </div>
              <div className="flex items-center gap-2">
                {order && <StatusPill status={order.status} />}
                {order && <StatusPill status={order.paymentStatus} />}
                {(order || draft.length > 0) && (
                  <button
                    onClick={() => { setOrder(null); resetDraft(); }}
                    title="Start a new order (this one stays open)"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border-2 border-brand bg-brand-pale px-3 py-1.5 text-sm font-bold text-brand-dark shadow-soft transition hover:bg-brand hover:text-white dark:text-brand dark:hover:text-white"
                  >
                    <Plus className="h-4 w-4" /> New order
                  </button>
                )}
              </div>
            </div>
            {!order ? (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-4 gap-1 rounded-xl bg-page p-1">
                  {modes.map((id) => MODES.find((m) => m.id === id)!).map((m) => (
                    <button key={m.id} onClick={() => setMode(m.id)} className={cx('flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] font-semibold', mode === m.id ? 'bg-card text-brand-dark shadow-soft' : 'text-ink-soft')}>
                      <m.icon className="h-4 w-4" /> {m.label}
                    </button>
                  ))}
                </div>
                {mode === 'dine_in' && (
                  <Select value={tableId} onChange={(e) => setTableId(e.target.value)} aria-label="Table">
                    <option value="">Select table…</option>
                    {tables.map((t) => <option key={t._id} value={t._id}>Table {t.number} · {t.capacity} seats · {t.status}</option>)}
                  </Select>
                )}
                {mode !== 'dine_in' && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input placeholder="Customer name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
                    <Input placeholder="Phone (for SMS)" inputMode="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
                  </div>
                )}
                {mode === 'delivery' && <Input placeholder="Delivery address" value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} />}
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
                <span>{order.type.replace('_', ' ')}{order.tableNumber ? ` · Table ${order.tableNumber}` : ''}</span>
                <span>Waiter: {order.waiterName}</span>
                {order.customerName && <span>Customer: {order.customerName}</span>}
                {order.source === 'offline' && <Pill color="yellow">offline sale</Pill>}
              </div>
            )}
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-2">
            {orderId && orderQ.isLoading ? (
              <div className="space-y-2 py-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
            ) : lines.length === 0 ? (
              <Empty title="No items yet" hint="Tap a product to add it to the order." icon={<ShoppingBag className="h-6 w-6" />} />
            ) : (
              <ul className="divide-y divide-line">
                {lines.map((l) => {
                  const isNew = !order || (l as { status?: string }).status === 'new';
                  const status = (l as { status?: string }).status;
                  return (
                    <li key={l.lineId} className="py-3">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold leading-tight">{l.name}</p>
                          {l.modifiers.length > 0 && <p className="text-xs text-ink-soft">{l.modifiers.map((m) => m.name).join(', ')}</p>}
                          {l.notes && <p className="text-xs italic text-warn-ink">“{l.notes}”</p>}
                          <div className="mt-1 flex items-center gap-1.5">
                            {order && status && status !== 'new' && <StatusPill status={status} />}
                            {(l as { complimentary?: boolean }).complimentary && <Pill color="blue">complimentary</Pill>}
                            {(l as { station?: string }).station === 'bar' ? <Martini className="h-3.5 w-3.5 text-ink-soft" /> : <ChefHat className="h-3.5 w-3.5 text-ink-soft" />}
                          </div>
                        </div>
                        <p className="text-sm font-bold">{money(order ? (l as { lineTotal: number }).lineTotal : l.unitPrice * l.qty)}</p>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        {isNew && !locked ? (
                          <div className="flex items-center gap-1 rounded-xl bg-page p-1">
                            <button className="grid h-8 w-8 place-items-center rounded-lg bg-card" onClick={() => changeQty(l.lineId, l.qty - 1)} aria-label="Decrease"><Minus className="h-4 w-4" /></button>
                            <span className="w-7 text-center text-sm font-bold">{l.qty}</span>
                            <button className="grid h-8 w-8 place-items-center rounded-lg bg-card" onClick={() => changeQty(l.lineId, l.qty + 1)} aria-label="Increase"><Plus className="h-4 w-4" /></button>
                          </div>
                        ) : (
                          <span className="text-xs text-ink-soft">Qty {l.qty} × {money(l.unitPrice)}</span>
                        )}
                        {!locked && <button className="rounded-lg p-2 text-ink-soft hover:bg-danger-pale hover:text-danger" onClick={() => voidLine(l.lineId, l.name)} aria-label="Remove item"><Trash2 className="h-4 w-4" /></button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="border-t border-line p-4">
            <dl className="space-y-1 text-sm">
              {order ? (
                <>
                  <Row label="Subtotal" value={money(order.totals.subtotal)} />
                  {order.totals.discount > 0 && <Row label={`Discount${order.discount?.reason ? ` (${order.discount.reason})` : ''}`} value={`− ${money(order.totals.discount)}`} />}
                  {order.totals.serviceCharge > 0 && <Row label="Service charge" value={money(order.totals.serviceCharge)} />}
                  {order.totals.deliveryFee > 0 && <Row label="Delivery fee" value={money(order.totals.deliveryFee)} />}
                  {(order.taxBreakdown ?? []).map((t) => <Row key={t.code} label={`${t.code} ${t.rateBps / 100}%${t.inclusive ? ' (incl.)' : ''}`} value={money(t.amount)} muted />)}
                  {order.totals.paid > 0 && <Row label="Paid" value={money(order.totals.paid)} />}
                  <div className="flex items-center justify-between pt-1 text-base font-bold"><dt>{order.totals.paid > 0 ? 'Balance' : 'Total'}</dt><dd>{money(order.totals.total - order.totals.paid)}</dd></div>
                </>
              ) : (
                <>
                  <Row label="Subtotal" value={money(draftTotal)} />
                  {estService > 0 && <Row label="Service charge (est.)" value={money(estService)} />}
                  <div className="flex items-center justify-between pt-1 text-base font-bold"><dt>Total (est.)</dt><dd>{money(draftTotal + estService)}</dd></div>
                  <p className="text-[11px] text-ink-soft">Taxes and final total are calculated by the server when the order is placed.</p>
                </>
              )}
            </dl>
            {!locked && (
              <div className="mt-3 grid grid-cols-4 gap-1.5">
                <IconBtn icon={Percent} label="Discount" onClick={discount} disabled={!order || !can('orders.discount')} />
                <IconBtn icon={order?.status === 'held' ? PlayCircle : PauseCircle} label={order?.status === 'held' ? 'Resume' : 'Hold'} onClick={() => (order ? action('hold', () => post(`/orders/${order._id}/${order.status === 'held' ? 'resume' : 'hold'}`), order.status === 'held' ? 'Order resumed' : 'Order held') : createFromDraft(false).then((o) => o && post(`/orders/${o._id}/hold`).then(() => { setOrder(null); toast('Order held'); })).catch(handleError))} disabled={!order && !draft.length} />
                <IconBtn icon={ArrowRightLeft} label="Transfer" onClick={() => setDialog('transfer')} disabled={!order || !can('orders.transfer')} />
                <IconBtn icon={Printer} label="Bill" onClick={printBill} disabled={!order} />
                <IconBtn icon={Merge} label="Merge" onClick={() => setDialog('merge')} disabled={!order || !can('orders.merge')} />
                <IconBtn icon={Split} label="Split" onClick={() => setDialog('split')} disabled={!order || order.totals.paid > 0} />
                <IconBtn icon={UserRound} label="Customer" onClick={() => setDialog('customer')} disabled={!order} />
                <IconBtn icon={StickyNote} label="Held" onClick={() => setDialog('held')} />
              </div>
            )}
            {order && !locked && can('orders.void') && order.totals.paid === 0 && (
              <button className="mt-2 flex w-full items-center justify-center gap-1 text-xs font-semibold text-danger" onClick={async () => {
                const c = await confirm({ title: `Void order ${order.number}?`, message: 'This cancels all items and kitchen tickets.', reason: true, danger: true, confirmLabel: 'Void order' });
                if (c.ok) action('void', () => withApproval((approval) => post(`/orders/${order._id}/void`, { reason: c.reason, approval })).then(() => setOrder(null)), 'Order voided');
              }}><Ban className="h-3.5 w-3.5" /> Void order</button>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button variant="secondary" size="lg" icon={<Send className="h-4 w-4" />} disabled={!hasNew || !!locked || !online} loading={busy === 'send'} onClick={() => placeOrder()}>Place order</Button>
              {locked ? (
                <Button size="lg" onClick={() => setPaying(true)} disabled={order?.status !== 'paid'}>Receipt</Button>
              ) : (
                <Button size="lg" disabled={lines.length === 0 || (order ? order.totals.total - order.totals.paid <= 0 : false)} loading={busy === 'pay'} onClick={() => startPayment()}>{online ? 'Pay' : 'Pay (offline)'}</Button>
              )}
            </div>
          </div>
        </aside>
      </div>

      {!showCart && (lines.length > 0 || order) && (
        <button className="fixed bottom-20 left-4 right-4 z-20 flex items-center justify-between rounded-2xl bg-brand px-5 py-4 font-semibold text-white shadow-lift md:hidden" onClick={() => setShowCart(true)}>
          <span>View order · {lines.reduce((s2, l) => s2 + l.qty, 0)} items</span>
          <span>{money(order ? order.totals.total - order.totals.paid : draftTotal + estService)}</span>
        </button>
      )}
      {/* ── Bottom service bar: active tables & orders ── */}
      <div className="scroll-thin flex shrink-0 gap-2 overflow-x-auto border-t border-line bg-card px-4 py-2.5">
        {activeChips.length === 0 ? (
          <p className="py-1.5 text-sm text-ink-soft">{online ? (can('orders.view_all') ? `No open ${outlet === 'bar' ? 'bar' : 'restaurant'} orders.` : `You have no open ${outlet === 'bar' ? 'bar' : 'restaurant'} orders.`) : 'Offline — active orders unavailable.'}</p>
        ) : (
          activeChips.map((c) => (
            <button key={c.id} onClick={() => setOrder(c.id)} title={`${c.number} · ${c.table.length <= 3 ? `Table ${c.table}` : c.table}`} className={cx('flex min-w-[170px] max-w-[230px] shrink-0 flex-col gap-1 rounded-xl border-2 px-3 py-2 text-left', orderId === c.id ? 'border-brand bg-brand-50' : 'border-line hover:border-brand/40')}>
              <span className="truncate text-sm font-bold tabular-nums">{c.number}</span>
              <div className="flex items-center justify-between gap-2 text-xs text-ink-soft">
                <span className="rounded-md bg-page px-1.5 py-0.5 font-semibold text-ink">{c.table.length <= 3 ? `T-${c.table}` : c.table}</span>
                <span>{c.itemCount} {c.itemCount === 1 ? 'item' : 'items'}</span>
              </div>
              <span className="truncate text-xs text-ink-soft">{c.waiterName ?? '—'} · {money(c.total)}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-page"><div className="h-full rounded-full bg-brand" style={{ width: `${Math.round((c.progress ?? 0) * 100)}%` }} /></div>
            </button>
          ))
        )}
      </div>

      {modFor && catalog && <ModifierDialog product={modFor} groups={catalog.modifierGroups} station={stationFor(modFor)} onClose={() => setModFor(null)} onConfirm={(l) => { setModFor(null); addLine(l); }} />}
      {paying && order && <PaymentDialog order={order} onClose={() => { setPaying(false); if (order.status === 'paid' || qc.getQueryData<{ order: Order }>(['order', order._id])?.order.status === 'paid') setOrder(null); }} onPaid={(o) => { qc.setQueryData(['order', o._id], { order: o }); qc.invalidateQueries({ queryKey: ['tables'] }); qc.invalidateQueries({ queryKey: ['catalog'] }); }} />}
      {offlineReceipt && <Modal open onClose={() => setOfflineReceipt(null)} title="Offline sale recorded" footer={<Button onClick={() => setOfflineReceipt(null)}>New order</Button>}><p className="text-sm">Cash sale of <b>{money(offlineReceipt.totals.total)}</b> saved on this terminal (ref {offlineReceipt.number.toUpperCase()}). It is <b>pending synchronisation</b> and will be verified by the server when the connection returns.</p></Modal>}
      {pickTableFor && (
        <TablePicker
          title="Choose a table"
          subtitle={`Pick the table for this dine-in order, then it will be ${pickTableFor === 'pay' ? 'sent and opened for payment' : 'sent to the kitchen and bar'}.`}
          tables={tables}
          onClose={() => setPickTableFor(null)}
          onPick={(id) => {
            const action = pickTableFor;
            setPickTableFor(null);
            setTableId(id);
            if (action === 'pay') startPayment(id);
            else placeOrder(id);
          }}
          onTakeaway={() => {
            setPickTableFor(null);
            setMode('takeaway');
            toast('Switched to takeaway — press the button again to continue', 'info');
          }}
        />
      )}
      {soldOutOpen && <SoldOutDialog onClose={() => setSoldOutOpen(false)} />}
      {pickRiderFor && (
        <AssignRiderDialog
          action={pickRiderFor}
          initial={{ address: deliveryAddress, customerName, customerPhone }}
          onClose={() => setPickRiderFor(null)}
          onConfirm={(d) => {
            const action = pickRiderFor;
            setPickRiderFor(null);
            setDeliveryAddress(d.address);
            setCustomerName(d.customerName);
            setCustomerPhone(d.customerPhone);
            if (action === 'pay') void startPayment(tableId, d);
            else void placeOrder(tableId, d);
          }}
        />
      )}
      {offlinePay && <OfflinePayDialog total={draft.reduce((a, d) => a + d.unitPrice * d.qty, 0)} allowed={offlineAllowed} hasTickets={draft.some((d) => d.station === 'kitchen' || d.station === 'bar')} onClose={() => setOfflinePay(false)} onConfirm={(p) => void recordOfflineSale(p)} />}
      {dialog === 'transfer' && order && <TablePicker title="Transfer to table" tables={tables.filter((t) => t._id !== order.tableId)} onClose={() => setDialog(null)} onPick={(id) => action('transfer', () => post(`/orders/${order._id}/transfer`, { tableId: id }), 'Order transferred').then(() => setDialog(null))} />}
      {dialog === 'merge' && order && <OrderPicker title="Merge another order into this one" orders={activeChips.filter((c) => c.id !== order._id)} onClose={() => setDialog(null)} onPick={(id) => action('merge', () => post(`/orders/${order._id}/merge`, { sourceOrderId: id }), 'Orders merged').then(() => setDialog(null))} />}
      {dialog === 'held' && <HeldOrders onClose={() => setDialog(null)} onPick={(id) => { setOrder(id); setDialog(null); }} />}
      {dialog === 'split' && order && <SplitDialog order={order} onClose={() => setDialog(null)} onDone={(newId) => { setDialog(null); toast('Bill split — new bill opened'); setOrder(newId); }} />}
      {dialog === 'customer' && order && <CustomerDialog order={order} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return <div className={cx('flex items-center justify-between', muted ? 'text-xs text-ink-soft' : 'text-ink-soft')}><dt>{label}</dt><dd className={muted ? '' : 'font-semibold text-ink'}>{value}</dd></div>;
}
function IconBtn({ icon: I, label, onClick, disabled }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex flex-col items-center gap-1 rounded-xl border border-line py-2 text-[11px] font-semibold text-ink-soft hover:border-brand/40 hover:text-ink disabled:opacity-40">
      <I className="h-4 w-4" /> {label}
    </button>
  );
}
function CategoryCard({ active, onClick, icon, name, count }: { active: boolean; onClick: () => void; icon: string; name: string; count: number }) {
  return (
    <button onClick={onClick} className={cx('flex min-w-[118px] flex-col items-start gap-2 rounded-2xl border-2 bg-card p-3 text-left shadow-soft transition', active ? 'border-brand' : 'border-transparent hover:border-brand/30')}>
      <span className={cx('grid h-9 w-9 place-items-center rounded-xl', active ? 'bg-brand text-white' : 'bg-brand-pale text-brand-dark')}><CategoryIcon name={icon} className="h-5 w-5" /></span>
      <span className="text-sm font-semibold leading-tight">{name}</span>
      <span className="text-xs text-ink-soft">{count} items</span>
    </button>
  );
}

const TABLE_ORDER: Record<string, number> = { available: 0, occupied: 1, reserved: 2, cleaning: 3 };
function TablePicker({ title, subtitle, tables, onClose, onPick, onTakeaway }: { title: string; subtitle?: string; tables: TablesResp['tables']; onClose: () => void; onPick: (id: string) => void; onTakeaway?: () => void }) {
  const sorted = [...tables].sort((a, b) => (TABLE_ORDER[a.status] ?? 9) - (TABLE_ORDER[b.status] ?? 9) || a.number.localeCompare(b.number, undefined, { numeric: true }));
  return (
    <Modal open onClose={onClose} title={title} size="lg" footer={onTakeaway && <Button variant="secondary" onClick={onTakeaway}>Make it takeaway instead</Button>}>
      {subtitle && <p className="mb-4 text-sm text-ink-soft">{subtitle}</p>}
      {sorted.length === 0 ? (
        <Empty title="No tables set up" hint="Add tables in Settings → Tables, or make this a takeaway order." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {sorted.map((t) => {
            const busy = t.orders.length > 0;
            return (
              <button
                key={t._id}
                autoFocus={t === sorted[0]}
                onClick={() => onPick(t._id)}
                className={cx(
                  'group flex flex-col gap-2 rounded-2xl border-2 p-3 text-left transition hover:-translate-y-0.5 hover:border-brand hover:shadow-soft focus-visible:border-brand focus-visible:outline-none',
                  t.status === 'available' ? 'border-brand/40 bg-brand-50' : 'border-line bg-card',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xl font-bold leading-none">{t.number}</span>
                  <StatusPill status={t.status} />
                </div>
                <span className="flex items-center gap-1 text-xs text-ink-soft"><Users className="h-3.5 w-3.5" /> {t.capacity} seats</span>
                {busy ? (
                  <span className="text-xs font-medium text-ink-soft">{t.orders.length} open order{t.orders.length > 1 ? 's' : ''} · {money(t.orders.reduce((a, o) => a + o.total, 0))}</span>
                ) : (
                  <span className="text-xs font-medium text-brand">Free</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
function OrderPicker({ title, orders, onClose, onPick }: { title: string; orders: Array<{ id: string; number: string; table: string; total: number }>; onClose: () => void; onPick: (id: string) => void }) {
  return (
    <Modal open onClose={onClose} title={title}>
      {orders.length === 0 ? <Empty title="No other open orders" /> : (
        <div className="space-y-2">{orders.map((o) => <button key={o.id} onClick={() => onPick(o.id)} className="flex w-full items-center justify-between rounded-xl border border-line px-4 py-3 hover:border-brand"><span className="font-semibold">{o.number} · {o.table}</span><span>{money(o.total)}</span></button>)}</div>
      )}
    </Modal>
  );
}
function HeldOrders({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const { data, isLoading } = useQuery<Order[]>({ queryKey: ['orders', 'held'], queryFn: () => get('/orders', { status: 'held', mine: '1' }) });
  return (
    <Modal open onClose={onClose} title="Held orders">
      {isLoading ? <Skeleton className="h-20" /> : !data?.length ? <Empty title="No held orders" /> : (
        <div className="space-y-2">{data.map((o) => <button key={o._id} onClick={() => onPick(o._id)} className="flex w-full items-center justify-between rounded-xl border border-line px-4 py-3 hover:border-brand"><span><b>{o.number}</b> <span className="text-xs text-ink-soft">{o.customerName ?? o.tableNumber ?? o.type}</span></span><span>{money(o.totals.total)}</span></button>)}</div>
      )}
    </Modal>
  );
}
function SplitDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (id: string) => void }) {
  const { handleError } = useFeedback();
  const [sel, setSel] = useState<Record<string, number>>({});
  const lines = order.items.filter((i) => !i.voided);
  return (
    <Modal open onClose={onClose} title="Split bill by item" footer={<Button disabled={!Object.values(sel).some((v) => v > 0)} onClick={() => post<{ created: Order }>(`/orders/${order._id}/split`, { lines: Object.entries(sel).filter(([, q]) => q > 0).map(([lineId, qty]) => ({ lineId, qty })) }).then((r) => onDone(r.created._id)).catch(handleError)}>Move to new bill</Button>}>
      <p className="mb-3 text-sm text-ink-soft">Choose items (and quantities) to move to a separate bill. To split by amount, take partial payments instead.</p>
      <div className="space-y-2">
        {lines.map((l) => (
          <div key={l.lineId} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
            <span className="text-sm">{l.name} <span className="text-ink-soft">× {l.qty}</span></span>
            <Input type="number" min={0} max={l.qty} step={1} className="w-20" value={sel[l.lineId] ?? 0} onChange={(e) => setSel({ ...sel, [l.lineId]: Math.min(l.qty, Math.max(0, Number(e.target.value))) })} />
          </div>
        ))}
      </div>
    </Modal>
  );
}
function CustomerDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const { data } = useQuery<Array<{ _id: string; name: string; phone?: string }>>({ queryKey: ['customers', q], queryFn: () => get('/crm/customers', { q }), enabled: q.length >= 2 });
  const attach = (id: string) => patch(`/orders/${order._id}`, { customerId: id }).then(() => { qc.invalidateQueries({ queryKey: ['order', order._id] }); toast('Customer attached — loyalty points will be awarded'); onClose(); }).catch(handleError);
  return (
    <Modal open onClose={onClose} title="Attach customer">
      <Field label="Search by name or phone"><Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      <div className="mt-3 space-y-2">{data?.map((c) => <button key={c._id} onClick={() => attach(c._id)} className="flex w-full justify-between rounded-xl border border-line px-4 py-3 hover:border-brand"><span className="font-semibold">{c.name}</span><span className="text-sm text-ink-soft">{c.phone}</span></button>)}</div>
    </Modal>
  );
}

export { ReceiptPanel, toCents };
