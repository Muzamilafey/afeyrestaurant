import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Upload } from 'lucide-react';
import { api, get, patch, post, put } from '@/lib/api';
import { dateTime, fromCents, money, titleCase, toCents } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, Pill, Select, StatusPill, Tabs, Textarea, Toggle } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';
import { AccountMenu } from '@/layout/AccountMenu';

type TabId = 'business' | 'branches' | 'users' | 'roles' | 'menu' | 'taxes' | 'tables' | 'audit' | 'account';

export default function SettingsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<TabId>(can('menu.manage') ? 'menu' : can('settings.manage') ? 'business' : 'account');
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs<TabId> tabs={[
        { id: 'menu', label: 'Menu & products', hidden: !can('menu.manage') },
        { id: 'business', label: 'Business', hidden: !can('settings.manage') },
        { id: 'branches', label: 'Branches', hidden: !can('branches.manage') },
        { id: 'users', label: 'Users', hidden: !can('users.manage') },
        { id: 'roles', label: 'Roles', hidden: !can('roles.manage') },
        { id: 'taxes', label: 'Taxes', hidden: !can('settings.manage') },
        { id: 'tables', label: 'Tables', hidden: !can('tables.manage') },
        { id: 'audit', label: 'Audit log', hidden: !can('audit.view') },
        { id: 'account', label: 'My account' },
      ]} value={tab} onChange={setTab} />
      {tab === 'menu' && <Menu />}
      {tab === 'business' && <Business />}
      {tab === 'branches' && <Branches />}
      {tab === 'users' && <Users />}
      {tab === 'roles' && <Roles />}
      {tab === 'taxes' && <Taxes />}
      {tab === 'tables' && <TablesAdmin />}
      {tab === 'audit' && <Audit />}
      {tab === 'account' && <Account />}
    </div>
  );
}

interface Product { _id: string; name: string; categoryId: string; price: number; sku?: string; barcode?: string; plu?: string; status: string; imageUrl?: string; description?: string; dietary: string[]; allergens: string[]; ageRestricted: boolean; modifierGroupIds: string[]; taxRateIds: string[]; happyHourPrice?: number | null; station: string; variants: Array<{ name: string; price: number }>; branchPrices: Array<{ branchId: string; price: number }> }
interface Cat { _id: string; name: string; icon: string; kind: string; station: string; sortOrder: number }

function Menu() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const products = useQuery<Product[]>({ queryKey: ['products'], queryFn: () => get('/menu/products') });
  const cats = useQuery<Cat[]>({ queryKey: ['categories'], queryFn: () => get('/menu/categories') });
  const groups = useQuery<Array<{ _id: string; name: string; minSelect: number; maxSelect: number; options: Array<{ _id?: string; name: string; priceDelta: number }> }>>({ queryKey: ['modifier-groups'], queryFn: () => get('/menu/modifier-groups') });
  const taxes = useQuery<Array<{ _id: string; name: string; active: boolean }>>({ queryKey: ['taxes'], queryFn: () => get('/admin/taxes') });
  const [edit, setEdit] = useState<Partial<Product> | null>(null);
  const [cat, setCat] = useState<Partial<Cat> | null>(null);
  const [grp, setGrp] = useState<null | { _id?: string; name: string; minSelect: number; maxSelect: number; options: Array<{ _id?: string; name: string; priceDelta: number }> }>(null);
  const cname = (id: string) => cats.data?.find((c) => c._id === id)?.name ?? '—';
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['products'] }); qc.invalidateQueries({ queryKey: ['catalog'] }); qc.invalidateQueries({ queryKey: ['categories'] }); qc.invalidateQueries({ queryKey: ['modifier-groups'] }); };

  async function saveProduct() {
    if (!edit) return;
    const body = { categoryId: edit.categoryId, name: edit.name, description: edit.description || undefined, imageUrl: edit.imageUrl || undefined, sku: edit.sku || undefined, barcode: edit.barcode || undefined, plu: edit.plu || undefined, price: edit.price, happyHourPrice: edit.happyHourPrice ?? null, status: edit.status, dietary: edit.dietary, allergens: edit.allergens, ageRestricted: edit.ageRestricted, modifierGroupIds: edit.modifierGroupIds, taxRateIds: edit.taxRateIds, station: edit.station, variants: edit.variants };
    try {
      if (edit._id) {
        const reason = products.data?.find((p) => p._id === edit._id)?.price !== edit.price ? window.prompt('Reason for price change') ?? undefined : undefined;
        await patch(`/menu/products/${edit._id}`, { ...body, priceChangeReason: reason });
      } else await post('/menu/products', body);
      invalidate();
      setEdit(null);
      toast('Product saved');
    } catch (e) {
      handleError(e);
    }
  }
  async function upload(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api<{ url: string }>('/menu/uploads/image', { method: 'POST', body: fd });
      setEdit((e) => ({ ...e, imageUrl: r.url }));
    } catch (e) {
      handleError(e);
    }
  }
  const DIET = ['vegetarian', 'vegan', 'halal', 'gluten_free', 'spicy', 'dairy_free', 'contains_nuts'];
  return (
    <div className="space-y-4">
      <Card title="Products" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ status: 'available', dietary: [], allergens: [], modifierGroupIds: [], taxRateIds: taxes.data?.filter((t) => t.active).map((t) => t._id) ?? [], station: 'inherit', variants: [], price: 0, categoryId: cats.data?.[0]?._id })}>Product</Button>}>
        <DataTable rows={products.data} loading={products.isLoading} rowKey={(r) => r._id} onRowClick={(r) => setEdit(r)} columns={[
          { key: 'n', header: 'Product', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-ink-soft">{r.sku} {r.plu && `· PLU ${r.plu}`} {r.barcode && `· ${r.barcode}`}</p></div> },
          { key: 'c', header: 'Category', render: (r) => cname(r.categoryId) }, { key: 'p', header: 'Price', render: (r) => money(r.price) },
          { key: 'd', header: 'Labels', render: (r) => <div className="flex flex-wrap gap-1">{r.ageRestricted && <Pill color="dark">18+</Pill>}{r.dietary.map((d) => <Pill key={d}>{d}</Pill>)}</div> },
          { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status === 'sold_out' ? 'out' : r.status === 'available' ? 'available' : r.status} /> },
        ]} />
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Categories" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCat({ kind: 'food', station: 'kitchen', icon: 'utensils' })}>Category</Button>}>
          <DataTable rows={cats.data} loading={cats.isLoading} rowKey={(r) => r._id} onRowClick={(r) => setCat(r)} columns={[{ key: 'n', header: 'Name', render: (r) => r.name }, { key: 'k', header: 'Kind', render: (r) => titleCase(r.kind) }, { key: 's', header: 'Routes to', render: (r) => <Pill>{r.station}</Pill> }]} />
        </Card>
        <Card title="Modifier groups" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setGrp({ name: '', minSelect: 0, maxSelect: 1, options: [{ name: '', priceDelta: 0 }] })}>Group</Button>}>
          <DataTable rows={groups.data} loading={groups.isLoading} rowKey={(r) => r._id} onRowClick={(r) => setGrp(r)} columns={[{ key: 'n', header: 'Group', render: (r) => r.name }, { key: 'r', header: 'Rule', render: (r) => `${r.minSelect}–${r.maxSelect}` }, { key: 'o', header: 'Options', render: (r) => <span className="text-xs">{r.options.map((o) => o.name).join(', ')}</span> }]} />
        </Card>
      </div>

      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit._id ? `Edit ${edit.name}` : 'New product'} size="xl" footer={<Button onClick={saveProduct}>Save</Button>}>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Name" className="md:col-span-2"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Category"><Select value={edit.categoryId ?? ''} onChange={(e) => setEdit({ ...edit, categoryId: e.target.value })}>{cats.data?.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</Select></Field>
            <Field label="Price (KSh)"><Input inputMode="decimal" value={fromCents(edit.price ?? 0)} onChange={(e) => setEdit({ ...edit, price: toCents(e.target.value || 0) })} /></Field>
            <Field label="Happy-hour price (KSh)" hint="Optional"><Input inputMode="decimal" value={edit.happyHourPrice != null ? fromCents(edit.happyHourPrice) : ''} onChange={(e) => setEdit({ ...edit, happyHourPrice: e.target.value ? toCents(e.target.value) : null })} /></Field>
            <Field label="Status"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{['available', 'sold_out', 'seasonal', 'archived'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field>
            <Field label="SKU"><Input value={edit.sku ?? ''} onChange={(e) => setEdit({ ...edit, sku: e.target.value })} /></Field>
            <Field label="Barcode"><Input value={edit.barcode ?? ''} onChange={(e) => setEdit({ ...edit, barcode: e.target.value })} /></Field>
            <Field label="PLU"><Input value={edit.plu ?? ''} onChange={(e) => setEdit({ ...edit, plu: e.target.value })} /></Field>
            <Field label="Station"><Select value={edit.station} onChange={(e) => setEdit({ ...edit, station: e.target.value })}><option value="inherit">From category</option><option value="kitchen">Kitchen</option><option value="bar">Bar</option><option value="none">None (counter)</option></Select></Field>
            <Field label="Image" className="md:col-span-2"><div className="flex items-center gap-2">{edit.imageUrl && <img src={edit.imageUrl} alt="" className="h-10 w-14 rounded-lg object-cover" />}<label className="btn-secondary cursor-pointer"><Upload className="h-4 w-4" /> Upload<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label></div></Field>
            <Field label="Description" className="md:col-span-3"><Textarea value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <div className="md:col-span-3"><p className="label">Dietary labels</p><div className="flex flex-wrap gap-2">{DIET.map((d) => <button type="button" key={d} onClick={() => setEdit({ ...edit, dietary: edit.dietary?.includes(d) ? edit.dietary.filter((x) => x !== d) : [...(edit.dietary ?? []), d] })} className={`rounded-full border px-3 py-1 text-xs font-semibold ${edit.dietary?.includes(d) ? 'border-brand bg-brand-pale text-brand-dark' : 'border-line'}`}>{titleCase(d)}</button>)}</div></div>
            <Field label="Allergens (comma separated)" className="md:col-span-2"><Input value={(edit.allergens ?? []).join(', ')} onChange={(e) => setEdit({ ...edit, allergens: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
            <div className="flex items-end"><Toggle checked={!!edit.ageRestricted} onChange={(v) => setEdit({ ...edit, ageRestricted: v })} label="Age-restricted (18+)" /></div>
            <div className="md:col-span-3"><p className="label">Modifier groups</p><div className="flex flex-wrap gap-2">{groups.data?.map((g) => <button type="button" key={g._id} onClick={() => setEdit({ ...edit, modifierGroupIds: edit.modifierGroupIds?.includes(g._id) ? edit.modifierGroupIds.filter((x) => x !== g._id) : [...(edit.modifierGroupIds ?? []), g._id] })} className={`rounded-full border px-3 py-1 text-xs font-semibold ${edit.modifierGroupIds?.includes(g._id) ? 'border-brand bg-brand-pale text-brand-dark' : 'border-line'}`}>{g.name}</button>)}</div></div>
            <div className="md:col-span-3"><p className="label">Taxes</p><div className="flex flex-wrap gap-2">{taxes.data?.map((t) => <button type="button" key={t._id} onClick={() => setEdit({ ...edit, taxRateIds: edit.taxRateIds?.includes(t._id) ? edit.taxRateIds.filter((x) => x !== t._id) : [...(edit.taxRateIds ?? []), t._id] })} className={`rounded-full border px-3 py-1 text-xs font-semibold ${edit.taxRateIds?.includes(t._id) ? 'border-brand bg-brand-pale text-brand-dark' : 'border-line'}`}>{t.name}{!t.active && ' (inactive)'}</button>)}</div></div>
            <div className="md:col-span-3"><p className="label">Sizes / variants</p>{(edit.variants ?? []).map((v, i) => <div key={i} className="mb-2 flex gap-2"><Input value={v.name} placeholder="e.g. Glass" onChange={(e) => setEdit({ ...edit, variants: edit.variants!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /><Input inputMode="decimal" value={fromCents(v.price)} onChange={(e) => setEdit({ ...edit, variants: edit.variants!.map((x, j) => (j === i ? { ...x, price: toCents(e.target.value || 0) } : x)) })} /><Button variant="ghost" size="sm" onClick={() => setEdit({ ...edit, variants: edit.variants!.filter((_, j) => j !== i) })}>✕</Button></div>)}<Button size="sm" variant="ghost" onClick={() => setEdit({ ...edit, variants: [...(edit.variants ?? []), { name: '', price: edit.price ?? 0 }] })}>Add size</Button></div>
          </div>
        </Modal>
      )}
      {cat && <Modal open onClose={() => setCat(null)} title={cat._id ? 'Edit category' : 'New category'} footer={<Button onClick={() => (cat._id ? patch(`/menu/categories/${cat._id}`, { name: cat.name, icon: cat.icon, kind: cat.kind, station: cat.station, sortOrder: Number(cat.sortOrder ?? 0) }) : post('/menu/categories', { name: cat.name, icon: cat.icon, kind: cat.kind, station: cat.station, sortOrder: Number(cat.sortOrder ?? 0) })).then(() => { invalidate(); setCat(null); }).catch(handleError)}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><Input value={cat.name ?? ''} onChange={(e) => setCat({ ...cat, name: e.target.value })} /></Field><Field label="Icon (lucide name)" hint="utensils, beef, salad, sandwich, cup-soda, beer, martini, wine, pizza, coffee, ice-cream, fish, soup, cake, drumstick, glass-water"><Input value={cat.icon ?? ''} onChange={(e) => setCat({ ...cat, icon: e.target.value })} /></Field><Field label="Kind"><Select value={cat.kind} onChange={(e) => setCat({ ...cat, kind: e.target.value })}>{['food', 'soft_drink', 'alcohol', 'cocktail', 'beer', 'wine', 'spirit', 'other'].map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}</Select></Field><Field label="Route tickets to"><Select value={cat.station} onChange={(e) => setCat({ ...cat, station: e.target.value })}><option value="kitchen">Kitchen</option><option value="bar">Bar</option><option value="none">None</option></Select></Field></div>
      </Modal>}
      {grp && <Modal open onClose={() => setGrp(null)} title={grp._id ? 'Edit modifier group' : 'New modifier group'} footer={<Button onClick={() => (grp._id ? put(`/menu/modifier-groups/${grp._id}`, { name: grp.name, minSelect: grp.minSelect, maxSelect: grp.maxSelect, options: grp.options }) : post('/menu/modifier-groups', grp)).then(() => { invalidate(); setGrp(null); }).catch(handleError)}>Save</Button>}>
        <div className="space-y-3"><div className="grid grid-cols-3 gap-2"><Field label="Name"><Input value={grp.name} onChange={(e) => setGrp({ ...grp, name: e.target.value })} /></Field><Field label="Min"><Input type="number" value={grp.minSelect} onChange={(e) => setGrp({ ...grp, minSelect: Number(e.target.value) })} /></Field><Field label="Max"><Input type="number" value={grp.maxSelect} onChange={(e) => setGrp({ ...grp, maxSelect: Number(e.target.value) })} /></Field></div>
          {grp.options.map((o, i) => <div key={i} className="flex gap-2"><Input placeholder="Option" value={o.name} onChange={(e) => setGrp({ ...grp, options: grp.options.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /><Input inputMode="decimal" placeholder="+KSh" value={fromCents(o.priceDelta)} onChange={(e) => setGrp({ ...grp, options: grp.options.map((x, j) => (j === i ? { ...x, priceDelta: toCents(e.target.value || 0) } : x)) })} /></div>)}
          <Button size="sm" variant="ghost" onClick={() => setGrp({ ...grp, options: [...grp.options, { name: '', priceDelta: 0 }] })}>Add option</Button></div>
      </Modal>}
    </div>
  );
}

function Business() {
  const { handleError, toast } = useFeedback();
  const { refreshSession } = useAuth();
  const qc = useQueryClient();
  const { data } = useQuery<{ name: string; kraPin?: string; contactEmail?: string; contactPhone?: string; branding: Record<string, string>; settings: Record<string, any> }>({ queryKey: ['tenant'], queryFn: () => get('/admin/tenant') });
  const [uploading, setUploading] = useState(false);
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data) setF(JSON.parse(JSON.stringify(data))); }, [data]);
  if (!f) return null;
  const s = f.settings;
  const uploadLogo = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true);
    try {
      const r = await api<{ url: string }>('/menu/uploads/image', { method: 'POST', body: fd });
      setF((x: any) => ({ ...x, branding: { ...x.branding, logoUrl: r.url } }));
    } catch (e) {
      handleError(e);
    } finally {
      setUploading(false);
    }
  };
  const save = () => patch('/admin/tenant', { name: f.name, kraPin: f.kraPin, contactEmail: f.contactEmail || undefined, contactPhone: f.contactPhone, branding: { primaryColor: f.branding.primaryColor, receiptHeader: f.branding.receiptHeader, receiptFooter: f.branding.receiptFooter, logoUrl: f.branding.logoUrl ?? '' }, settings: { discountApprovalThresholdBps: Number(s.discountApprovalThresholdBps), loyaltyPointsPer100: Number(s.loyaltyPointsPer100), costingPolicy: s.costingPolicy, allowNegativeStock: s.allowNegativeStock, mpesaTimeoutSeconds: Number(s.mpesaTimeoutSeconds), offlineAllowedActions: s.offlineAllowedActions, alertEmails: s.alertEmails, dailySummary: s.dailySummary, lowStockAlerts: s.lowStockAlerts } }).then(async () => { await refreshSession(); qc.invalidateQueries({ queryKey: ['public-business'] }); toast('Business settings saved'); }).catch(handleError);
  return (
    <Card title="Business settings" actions={<Button size="sm" onClick={save}>Save</Button>}>
      <div className="mb-5 flex flex-wrap items-center gap-4 rounded-2xl bg-page p-4">
        {f.branding.logoUrl ? <img src={f.branding.logoUrl} alt="Logo" className="h-16 w-16 rounded-2xl object-cover" /> : <span className="grid h-16 w-16 place-items-center rounded-2xl bg-brand text-2xl font-black text-white">{f.name?.[0]?.toUpperCase()}</span>}
        <div className="min-w-[200px] flex-1">
          <Field label="Business name" hint="Shown on the sign-in screen, sidebar, receipts and customer messages"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        <div className="flex gap-2">
          <label className="btn-secondary cursor-pointer"><Upload className="h-4 w-4" /> {uploading ? 'Uploading…' : f.branding.logoUrl ? 'Change logo' : 'Upload logo'}<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} /></label>
          {f.branding.logoUrl && <Button variant="ghost" onClick={() => setF({ ...f, branding: { ...f.branding, logoUrl: '' } })}>Remove</Button>}
        </div>
        <p className="w-full text-xs text-ink-soft">Square PNG, JPG or WebP, up to 5 MB. Changes apply after you press Save.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="KRA PIN"><Input value={f.kraPin ?? ''} onChange={(e) => setF({ ...f, kraPin: e.target.value })} /></Field>
        <Field label="Contact email"><Input value={f.contactEmail ?? ''} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></Field>
        <Field label="Receipt header"><Input value={f.branding.receiptHeader ?? ''} onChange={(e) => setF({ ...f, branding: { ...f.branding, receiptHeader: e.target.value } })} /></Field>
        <Field label="Receipt footer"><Input value={f.branding.receiptFooter ?? ''} onChange={(e) => setF({ ...f, branding: { ...f.branding, receiptFooter: e.target.value } })} /></Field>
        <Field label="Brand colour"><Input type="color" value={f.branding.primaryColor ?? '#07963C'} onChange={(e) => setF({ ...f, branding: { ...f.branding, primaryColor: e.target.value } })} /></Field>
        <Field label="Discount approval threshold (%)"><Input inputMode="decimal" value={s.discountApprovalThresholdBps / 100} onChange={(e) => setF({ ...f, settings: { ...s, discountApprovalThresholdBps: Math.round(Number(e.target.value) * 100) } })} /></Field>
        <Field label="Loyalty points per KSh 100"><Input inputMode="decimal" value={s.loyaltyPointsPer100} onChange={(e) => setF({ ...f, settings: { ...s, loyaltyPointsPer100: e.target.value } })} /></Field>
        <Field label="Inventory costing"><Select value={s.costingPolicy} onChange={(e) => setF({ ...f, settings: { ...s, costingPolicy: e.target.value } })}><option value="fifo">FIFO</option><option value="weighted_average">Weighted average</option></Select></Field>
        <Field label="M-Pesa prompt timeout (s)"><Input inputMode="numeric" value={s.mpesaTimeoutSeconds} onChange={(e) => setF({ ...f, settings: { ...s, mpesaTimeoutSeconds: e.target.value } })} /></Field>
        <Field label="Alert emails (comma separated)"><Input value={(s.alertEmails ?? []).join(', ')} onChange={(e) => setF({ ...f, settings: { ...s, alertEmails: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) } })} /></Field>
        <div className="flex flex-col gap-2 md:col-span-3">
          <Toggle checked={!!s.allowNegativeStock} onChange={(v) => setF({ ...f, settings: { ...s, allowNegativeStock: v } })} label="Allow negative stock without manager override" />
          <Toggle checked={!!s.dailySummary} onChange={(v) => setF({ ...f, settings: { ...s, dailySummary: v } })} label="Send daily sales summary to alert contacts" />
          <Toggle checked={s.lowStockAlerts !== false} onChange={(v) => setF({ ...f, settings: { ...s, lowStockAlerts: v } })} label="Send low-stock alerts" />
          <p className="label mt-2">Allowed offline actions</p>
          <div className="flex flex-wrap gap-3">{['browse', 'create_order', 'cash_payment', 'print'].map((a) => <Toggle key={a} checked={s.offlineAllowedActions?.includes(a)} onChange={(v) => setF({ ...f, settings: { ...s, offlineAllowedActions: v ? [...s.offlineAllowedActions, a] : s.offlineAllowedActions.filter((x: string) => x !== a) } })} label={titleCase(a)} />)}</div>
        </div>
      </div>
    </Card>
  );
}

function Branches() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Array<{ _id: string; name: string; code: string; address?: string; active: boolean; settings: Record<string, any> }>>({ queryKey: ['branches'], queryFn: () => get('/admin/branches') });
  const [f, setF] = useState<any>(null);
  const save = () => (f._id ? patch(`/admin/branches/${f._id}`, { name: f.name, address: f.address, settings: { serviceChargeBps: Math.round(Number(f.sc) * 100), kitchenDelayMinutes: Number(f.settings?.kitchenDelayMinutes ?? 15), enabledModes: f.settings?.enabledModes, deliveryFee: toCents(f.deliveryFee || 0) } }) : post('/admin/branches', { name: f.name, code: f.code, address: f.address })).then(() => { qc.invalidateQueries({ queryKey: ['branches'] }); setF(null); toast('Branch saved — sign out and in again to see new branches'); }).catch(handleError);
  return (
    <Card title="Branches" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setF({ name: '', code: '', address: '' })}>Branch</Button>}>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} onRowClick={(r) => setF({ ...r, sc: (r.settings?.serviceChargeBps ?? 0) / 100, deliveryFee: fromCents(r.settings?.deliveryFee ?? 0) })} columns={[{ key: 'n', header: 'Branch', render: (r) => <b>{r.name}</b> }, { key: 'c', header: 'Code', render: (r) => r.code }, { key: 'a', header: 'Address', render: (r) => r.address }, { key: 's', header: 'Service charge', render: (r) => `${(r.settings?.serviceChargeBps ?? 0) / 100}%` }, { key: 'm', header: 'Modes', render: (r) => <span className="text-xs">{(r.settings?.enabledModes ?? []).join(', ')}</span> }]} />
      {f && <Modal open onClose={() => setF(null)} title={f._id ? 'Edit branch' : 'New branch'} footer={<Button onClick={save}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Code"><Input disabled={!!f._id} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Address" className="sm:col-span-2"><Input value={f.address ?? ''} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          {f._id && <>
            <Field label="Service charge %"><Input inputMode="decimal" value={f.sc} onChange={(e) => setF({ ...f, sc: e.target.value })} /></Field>
            <Field label="Delivery fee (KSh)"><Input inputMode="decimal" value={f.deliveryFee} onChange={(e) => setF({ ...f, deliveryFee: e.target.value })} /></Field>
            <div className="sm:col-span-2"><p className="label">Dining modes</p><div className="flex flex-wrap gap-3">{['dine_in', 'takeaway', 'delivery', 'bar_counter', 'room_service', 'online'].map((m) => <Toggle key={m} checked={f.settings?.enabledModes?.includes(m)} onChange={(v) => setF({ ...f, settings: { ...f.settings, enabledModes: v ? [...(f.settings?.enabledModes ?? []), m] : f.settings.enabledModes.filter((x: string) => x !== m) } })} label={titleCase(m)} />)}</div></div>
          </>}
        </div>
      </Modal>}
    </Card>
  );
}

function Users() {
  const { session } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const users = useQuery<Array<{ id: string; name: string; email: string; roleId: string; branchIds: string[]; active: boolean; lastLoginAt?: string; mfaEnabled: boolean; lockedUntil?: string }>>({ queryKey: ['users'], queryFn: () => get('/admin/users') });
  const roles = useQuery<{ roles: Array<{ _id: string; name: string; key: string }> }>({ queryKey: ['roles'], queryFn: () => get('/admin/roles') });
  const [f, setF] = useState<any>(null);
  const rname = (id: string) => roles.data?.roles.find((r) => r._id === id)?.name ?? '—';
  const save = () => (f.id ? patch(`/admin/users/${f.id}`, { name: f.name, roleId: f.roleId, branchIds: f.branchIds, active: f.active, password: f.password || undefined, pin: f.pin || undefined }) : post('/admin/users', { name: f.name, email: f.email, roleId: f.roleId, branchIds: f.branchIds, password: f.password, pin: f.pin || undefined })).then(() => { qc.invalidateQueries({ queryKey: ['users'] }); setF(null); toast('User saved'); }).catch(handleError);
  return (
    <Card title="Users" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setF({ name: '', email: '', roleId: roles.data?.roles.find((r) => r.key === 'cashier')?._id, branchIds: [session?.branches[0]?.id], password: '', pin: '', active: true })}>User</Button>}>
      <DataTable rows={users.data} loading={users.isLoading} rowKey={(r) => r.id} onRowClick={(r) => setF({ ...r, password: '', pin: '' })} columns={[{ key: 'n', header: 'Name', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-ink-soft">{r.email}</p></div> }, { key: 'r', header: 'Role', render: (r) => rname(r.roleId) }, { key: 'b', header: 'Branches', render: (r) => r.branchIds.map((b) => session?.branches.find((x) => x.id === b)?.code ?? '').join(', ') }, { key: 'l', header: 'Last login', render: (r) => dateTime(r.lastLoginAt) }, { key: 'm', header: 'MFA', render: (r) => (r.mfaEnabled ? <Pill color="green">On</Pill> : <Pill>Off</Pill>) }, { key: 's', header: 'Status', render: (r) => (r.lockedUntil && new Date(r.lockedUntil) > new Date() ? <Pill color="red">Locked</Pill> : <StatusPill status={r.active ? 'active' : 'suspended'} />) }]} />
      {f && <Modal open onClose={() => setF(null)} title={f.id ? 'Edit user' : 'New user'} footer={<Button onClick={save}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email"><Input disabled={!!f.id} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role"><Select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>{roles.data?.roles.map((r) => <option key={r._id} value={r._id}>{r.name}</option>)}</Select></Field>
          <Field label={f.id ? 'Reset password' : 'Password'} hint="10+ chars, upper/lower case and a number"><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Field label={f.id ? 'Reset PIN (4–6 digits)' : 'PIN (4–6 digits)'} hint="For PIN sign-in and approvals"><Input type="password" inputMode="numeric" maxLength={6} value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></Field>
          <div><p className="label">Branches</p>{session?.branches.map((b) => <label key={b.id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-brand" checked={f.branchIds.includes(b.id)} onChange={(e) => setF({ ...f, branchIds: e.target.checked ? [...f.branchIds, b.id] : f.branchIds.filter((x: string) => x !== b.id) })} />{b.name}</label>)}</div>
          {f.id && <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Active" />}
        </div>
      </Modal>}
    </Card>
  );
}

function Roles() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data } = useQuery<{ roles: Array<{ _id: string; key: string; name: string; description?: string; permissions: string[]; branchScoped: boolean; system: boolean }>; permissions: string[] }>({ queryKey: ['roles'], queryFn: () => get('/admin/roles') });
  const [f, setF] = useState<any>(null);
  const groups = (data?.permissions ?? []).reduce((a: Record<string, string[]>, p) => ({ ...a, [p.split('.')[0]]: [...(a[p.split('.')[0]] ?? []), p] }), {});
  return (
    <Card title="Roles & permissions" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setF({ key: '', name: '', permissions: [], branchScoped: true })}>Custom role</Button>}>
      <DataTable rows={data?.roles} rowKey={(r) => r._id} onRowClick={(r) => r.key !== 'owner' && setF(r)} columns={[{ key: 'n', header: 'Role', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-ink-soft">{r.description}</p></div> }, { key: 'p', header: 'Permissions', render: (r) => r.permissions.length }, { key: 'b', header: 'Scope', render: (r) => (r.branchScoped ? 'Assigned branches' : 'All branches') }, { key: 's', header: '', render: (r) => (r.system ? <Pill>system</Pill> : <Pill color="blue">custom</Pill>) }]} />
      {f && <Modal open onClose={() => setF(null)} title={f._id ? `Edit ${f.name}` : 'New role'} size="xl" footer={<Button onClick={() => put(`/admin/roles/${f.key}`, { key: f.key, name: f.name, description: f.description, permissions: f.permissions, branchScoped: f.branchScoped }).then(() => { qc.invalidateQueries({ queryKey: ['roles'] }); setF(null); toast('Role saved'); }).catch(handleError)}>Save</Button>}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3"><Field label="Key"><Input disabled={!!f._id} value={f.key} onChange={(e) => setF({ ...f, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Field><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><div className="flex items-end"><Toggle checked={!f.branchScoped} onChange={(v) => setF({ ...f, branchScoped: !v })} label="All branches" /></div></div>
          <div className="grid gap-3 md:grid-cols-3">{Object.entries(groups).map(([g, ps]) => <div key={g} className="rounded-xl border border-line p-3"><p className="label">{titleCase(g)}</p>{ps.map((p) => <label key={p} className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-brand" checked={f.permissions.includes(p)} onChange={(e) => setF({ ...f, permissions: e.target.checked ? [...f.permissions, p] : f.permissions.filter((x: string) => x !== p) })} />{p.split('.')[1].replace(/_/g, ' ')}</label>)}</div>)}</div>
        </div>
      </Modal>}
    </Card>
  );
}

function Taxes() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data } = useQuery<Array<{ _id: string; code: string; name: string; rateBps: number; inclusive: boolean; active: boolean }>>({ queryKey: ['taxes'], queryFn: () => get('/admin/taxes') });
  const [f, setF] = useState<any>(null);
  return (
    <Card title="Tax rates" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setF({ code: '', name: '', rate: '16', inclusive: true, active: true })}>Tax</Button>}>
      <p className="mb-3 text-sm text-ink-soft">Configure the taxes that apply to your business (e.g. VAT, Catering Levy) and assign them per product. Confirm current rates with KRA or your tax adviser.</p>
      <DataTable rows={data} rowKey={(r) => r._id} onRowClick={(r) => setF({ ...r, rate: r.rateBps / 100 })} columns={[{ key: 'c', header: 'Code', render: (r) => r.code }, { key: 'n', header: 'Name', render: (r) => r.name }, { key: 'r', header: 'Rate', render: (r) => `${r.rateBps / 100}%` }, { key: 'i', header: 'Pricing', render: (r) => (r.inclusive ? 'Included in price' : 'Added on top') }, { key: 'a', header: 'Status', render: (r) => <StatusPill status={r.active ? 'active' : 'closed'} /> }]} />
      {f && <Modal open onClose={() => setF(null)} title="Tax rate" footer={<Button onClick={() => put(`/admin/taxes/${f.code}`, { name: f.name, rateBps: Math.round(Number(f.rate) * 100), inclusive: f.inclusive, active: f.active }).then(() => { qc.invalidateQueries({ queryKey: ['taxes'] }); setF(null); toast('Saved'); }).catch(handleError)}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Code"><Input disabled={!!f._id} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Rate %"><Input inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field><div className="flex flex-col justify-end gap-2"><Toggle checked={f.inclusive} onChange={(v) => setF({ ...f, inclusive: v })} label="Included in menu price" /><Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Active" /></div></div>
      </Modal>}
    </Card>
  );
}

function TablesAdmin() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data } = useQuery<{ areas: Array<{ _id: string; name: string }>; tables: Array<{ _id: string; number: string; capacity: number; areaId?: string; shape: string; status: string }> }>({ queryKey: ['tables'], queryFn: () => get('/tables') });
  const [t, setT] = useState<any>(null);
  return (
    <Card title="Tables & dining areas" actions={<><Button size="sm" variant="secondary" onClick={() => { const name = window.prompt('Area name'); if (name) post('/tables/areas', { name }).then(() => qc.invalidateQueries({ queryKey: ['tables'] })).catch(handleError); }}>Area</Button><Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setT({ number: '', capacity: 4, areaId: data?.areas[0]?._id, shape: 'square' })}>Table</Button></>}>
      <DataTable rows={data?.tables} rowKey={(r) => r._id} onRowClick={(r) => setT(r)} columns={[{ key: 'n', header: 'Table', render: (r) => <b>T-{r.number}</b> }, { key: 'a', header: 'Area', render: (r) => data?.areas.find((a) => a._id === r.areaId)?.name ?? '—' }, { key: 'c', header: 'Seats', render: (r) => r.capacity }, { key: 's', header: 'Shape', render: (r) => r.shape }, { key: 'st', header: 'Status', render: (r) => <StatusPill status={r.status} /> }]} />
      {t && <Modal open onClose={() => setT(null)} title={t._id ? `Table ${t.number}` : 'New table'} footer={<Button onClick={() => (t._id ? patch(`/tables/${t._id}`, { number: t.number, capacity: Number(t.capacity), areaId: t.areaId, shape: t.shape }) : post('/tables', { number: t.number, capacity: Number(t.capacity), areaId: t.areaId, shape: t.shape })).then(() => { qc.invalidateQueries({ queryKey: ['tables'] }); setT(null); toast('Saved'); }).catch(handleError)}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Number"><Input value={t.number} onChange={(e) => setT({ ...t, number: e.target.value })} /></Field><Field label="Seats"><Input type="number" value={t.capacity} onChange={(e) => setT({ ...t, capacity: e.target.value })} /></Field><Field label="Area"><Select value={t.areaId} onChange={(e) => setT({ ...t, areaId: e.target.value })}>{data?.areas.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}</Select></Field><Field label="Shape"><Select value={t.shape} onChange={(e) => setT({ ...t, shape: e.target.value })}><option value="square">Square</option><option value="round">Round</option><option value="rect">Rectangle</option></Select></Field></div>
      </Modal>}
    </Card>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const { data, isLoading } = useQuery<Array<{ _id: string; createdAt: string; actorName?: string; action: string; entity?: string; reason?: string; approvedBy?: string; meta?: unknown }>>({ queryKey: ['audit', action], queryFn: () => get('/admin/audit', { action: action || undefined }) });
  return (
    <Card title="Audit trail" actions={<Input placeholder="Filter by action, e.g. order." className="w-64" value={action} onChange={(e) => setAction(e.target.value)} />}>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[{ key: 'd', header: 'When', render: (r) => dateTime(r.createdAt) }, { key: 'u', header: 'User', render: (r) => r.actorName ?? 'system' }, { key: 'a', header: 'Action', render: (r) => <code className="text-xs">{r.action}</code> }, { key: 'r', header: 'Reason', render: (r) => r.reason }, { key: 'x', header: 'Approved', render: (r) => (r.approvedBy ? <Pill color="green">approved</Pill> : null) }, { key: 'm', header: 'Details', render: (r) => <span className="line-clamp-2 max-w-xs text-xs text-ink-soft">{r.meta ? JSON.stringify(r.meta) : ''}</span> }]} />
    </Card>
  );
}

function Account() {
  const { session } = useAuth();
  const { handleError, toast } = useFeedback();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [pinOpen, setPinOpen] = useState(false);
  const [mfa, setMfa] = useState<null | { secret: string; otpauthUrl: string }>(null);
  const [code, setCode] = useState('');
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card title="Change password"><div className="space-y-3"><Field label="Current password"><Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field><Field label="New password"><Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field><Button onClick={() => post('/auth/change-password', pw).then(() => { toast('Password changed. Other sessions were signed out.'); setPw({ currentPassword: '', newPassword: '' }); }).catch(handleError)}>Update</Button></div></Card>
      <Card title="My PIN"><div className="space-y-3"><p className="text-sm text-ink-soft">Your PIN (4–6 digits) signs you in on POS terminals and approves voids, discounts and refunds.</p><Button onClick={() => setPinOpen(true)}>Change PIN</Button></div>{pinOpen && <AccountMenu onClose={() => setPinOpen(false)} />}</Card>
      <Card title="Two-factor authentication">
        {session?.user.mfaEnabled ? <p className="text-sm"><Pill color="green">Enabled</Pill> Your account requires an authenticator code at sign-in.</p> : mfa ? (
          <div className="space-y-3 text-sm"><p>Add this key to Google Authenticator, Authy or Microsoft Authenticator:</p><code className="block break-all rounded-xl bg-page p-3">{mfa.secret}</code><Field label="6-digit code"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></Field><Button onClick={() => post('/auth/mfa/enable', { code }).then(() => toast('MFA enabled')).catch(handleError)}>Verify & enable</Button></div>
        ) : <div className="space-y-3"><p className="text-sm text-ink-soft">Recommended for owners, managers and accountants.</p><Button onClick={() => post<{ secret: string; otpauthUrl: string }>('/auth/mfa/setup').then(setMfa).catch(handleError)}>Set up</Button></div>}
      </Card>
    </div>
  );
}
