import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, History } from 'lucide-react';
import { get, put } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, Pill, Select, Empty } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface Product { _id: string; name: string; price: number; variants: Array<{ name: string }> }
interface Ing { _id: string; name: string; baseUnit: string; units: Array<{ name: string; factor: number }>; lastCost: number }
interface Version { _id: string; version: number; yield: number; createdAt: string; lines: Array<{ ingredientId: string; ingredientName: string; qty: number; unit: string; baseQty: number }> }
interface Recipe { _id: string; productId: string; variant: string; currentVersion: number; current: Version | null }

export default function RecipesPage() {
  const { can } = useAuth();
  const products = useQuery<Product[]>({ queryKey: ['products'], queryFn: () => get('/menu/products') });
  const recipes = useQuery<Recipe[]>({ queryKey: ['recipes'], queryFn: () => get('/inventory/recipes') });
  const ings = useQuery<Ing[]>({ queryKey: ['ingredients'], queryFn: () => get('/inventory/ingredients') });
  const [edit, setEdit] = useState<{ product: Product; variant: string } | null>(null);
  const [history, setHistory] = useState<Product | null>(null);
  const rows = useMemo(() => (products.data ?? []).flatMap((p) => ['', ...p.variants.map((v) => v.name)].map((variant) => ({ p, variant, r: recipes.data?.find((r) => r.productId === p._id && r.variant === variant) }))).filter((x) => x.variant === '' || x.r), [products.data, recipes.data]);
  const cost = (v?: Version | null) => (v ? v.lines.reduce((s, l) => s + l.baseQty * (ings.data?.find((i) => i._id === l.ingredientId)?.lastCost ?? 0), 0) / (v.yield || 1) : 0);

  return (
    <div>
      <PageHeader title="Recipes & stock" subtitle="Ingredients deducted per sale. Each change creates a new version; past sales keep the version they used." />
      <Card>
        <DataTable rows={rows} loading={products.isLoading || recipes.isLoading} rowKey={(x) => x.p._id + x.variant} columns={[
          { key: 'p', header: 'Menu item', render: (x) => <div><p className="font-semibold">{x.p.name}{x.variant && ` (${x.variant})`}</p><p className="text-xs text-ink-soft">{money(x.p.price)}</p></div> },
          { key: 'v', header: 'Version', render: (x) => (x.r ? <Pill color="green">v{x.r.currentVersion}</Pill> : <Pill>No recipe</Pill>) },
          { key: 'l', header: 'Ingredients', render: (x) => <span className="text-xs">{x.r?.current?.lines.map((l) => `${l.ingredientName} ${l.qty}${l.unit}`).join(', ') ?? '—'}</span> },
          { key: 'c', header: 'Food cost', render: (x) => { const c = cost(x.r?.current); return x.r ? <span>{money(Math.round(c))} <span className="text-xs text-ink-soft">({x.p.price ? Math.round((c / x.p.price) * 100) : 0}%)</span></span> : '—'; } },
          { key: 'a', header: '', render: (x) => <div className="flex gap-1">{can('recipes.manage') && <Button size="sm" variant="secondary" onClick={() => setEdit({ product: x.p, variant: x.variant })}>{x.r ? 'Edit' : 'Create'}</Button>}{x.r && <Button size="sm" variant="ghost" icon={<History className="h-4 w-4" />} onClick={() => setHistory(x.p)} />}</div> },
        ]} />
      </Card>
      {edit && ings.data && <RecipeEditor product={edit.product} variant={edit.variant} ings={ings.data} current={recipes.data?.find((r) => r.productId === edit.product._id && r.variant === edit.variant)?.current ?? null} onClose={() => setEdit(null)} />}
      {history && <VersionHistory product={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function RecipeEditor({ product, variant, ings, current, onClose }: { product: Product; variant: string; ings: Ing[]; current: Version | null; onClose: () => void }) {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [yieldN, setYield] = useState(String(current?.yield ?? 1));
  const [lines, setLines] = useState(current?.lines.map((l) => ({ ingredientId: l.ingredientId, qty: String(l.qty), unit: l.unit })) ?? [{ ingredientId: '', qty: '', unit: '' }]);
  const ing = (id: string) => ings.find((i) => i._id === id);
  const save = () => put(`/inventory/recipes/${product._id}`, { variant: variant || undefined, yield: Number(yieldN) || 1, lines: lines.filter((l) => l.ingredientId && Number(l.qty) > 0).map((l) => ({ ingredientId: l.ingredientId, qty: Number(l.qty), unit: l.unit || undefined })) })
    .then((v: { version: number }) => { qc.invalidateQueries({ queryKey: ['recipes'] }); qc.invalidateQueries({ queryKey: ['catalog'] }); toast(`Saved as version ${v.version}`); onClose(); })
    .catch(handleError);
  return (
    <Modal open onClose={onClose} title={`Recipe — ${product.name}${variant ? ` (${variant})` : ''}`} size="lg" footer={<Button onClick={save}>Save new version</Button>}>
      <div className="space-y-3">
        <Field label="Yield (portions this recipe makes)" className="max-w-xs"><Input inputMode="decimal" value={yieldN} onChange={(e) => setYield(e.target.value)} /></Field>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2">
            <Select value={l.ingredientId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value, unit: '' } : x)))}><option value="">Ingredient…</option>{ings.map((x) => <option key={x._id} value={x._id}>{x.name}</option>)}</Select>
            <Input inputMode="decimal" placeholder="qty" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
            <Select value={l.unit} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}>
              <option value="">{ing(l.ingredientId)?.baseUnit ?? 'unit'}</option>
              {ing(l.ingredientId)?.baseUnit === 'g' && <option value="kg">kg</option>}
              {ing(l.ingredientId)?.baseUnit === 'ml' && <><option value="l">l</option><option value="cl">cl</option></>}
              {ing(l.ingredientId)?.units.map((u) => <option key={u.name} value={u.name}>{u.name} ({u.factor}{ing(l.ingredientId)?.baseUnit})</option>)}
            </Select>
            <Button variant="ghost" size="sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setLines([...lines, { ingredientId: '', qty: '', unit: '' }])}>Add ingredient</Button>
      </div>
    </Modal>
  );
}

function VersionHistory({ product, onClose }: { product: Product; onClose: () => void }) {
  const { data } = useQuery<Version[]>({ queryKey: ['recipe-versions', product._id], queryFn: () => get(`/inventory/recipes/${product._id}/versions`) });
  return (
    <Modal open onClose={onClose} title={`Version history — ${product.name}`}>
      {!data?.length ? <Empty title="No versions" /> : data.map((v) => (
        <div key={v._id} className="mb-3 rounded-xl border border-line p-3">
          <p className="font-semibold">v{v.version} <span className="text-xs font-normal text-ink-soft">{dateTime(v.createdAt)} · yield {v.yield}</span></p>
          <p className="text-sm">{v.lines.map((l) => `${l.ingredientName} ${l.qty}${l.unit}`).join(', ')}</p>
        </div>
      ))}
    </Modal>
  );
}
