import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChefHat, Bike } from 'lucide-react';
import { get } from '@/lib/api';

export default function TrackOrder() {
  const { code } = useParams();
  const { data, error } = useQuery<{ restaurant: string; number: string; status: string; deliveryStatus?: string; ready: boolean }>({ queryKey: ['track', code], queryFn: () => get(`/public/track/${code}`), refetchInterval: 20_000 });
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="card w-full max-w-sm p-6 text-center">
        {error ? <p>Order not found.</p> : !data ? <p>Loading…</p> : (
          <>
            <p className="text-sm text-ink-soft">{data.restaurant}</p>
            <h1 className="text-2xl font-bold">Order {data.number}</h1>
            <div className="mt-6 flex flex-col items-center gap-2">
              {data.deliveryStatus === 'delivered' ? <CheckCircle2 className="h-12 w-12 text-brand" /> : data.deliveryStatus === 'picked_up' ? <Bike className="h-12 w-12 text-brand" /> : data.ready ? <CheckCircle2 className="h-12 w-12 text-brand" /> : <ChefHat className="h-12 w-12 text-warn" />}
              <p className="font-semibold">{data.deliveryStatus === 'delivered' ? 'Delivered' : data.deliveryStatus === 'picked_up' ? 'On the way' : data.ready ? 'Ready' : 'Being prepared'}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
