// Remittance route comparison from dated fee snapshots.
//
// A route charges a fixed fee and a percentage fee on the KES sent, then
// converts the rest at an offered rate that sits below the mid-market rate
// by a hidden margin:
//   received = (amount − fee_fixed − amount·fee_pct) · r_offered
//   margin   = (r_mid − r_offered) / r_mid
// with r expressed as foreign currency per KES.

export interface Route {
  id: string;
  routeName: string;
  routeKind: string;
  toCurrency: string;
  feeFixedMinor: number; // KES minor units
  feePct: number;
  fxMarginPct: number;
  minSendMinor: number; // KES minor units
  maxSendMinor: number;
  arrivalHours: number;
  requires: string[];
  snapshotDate: string;
}

export interface SendQuote {
  routeId: string;
  sendKesMinor: number;
  feeKesMinor: number;
  receivedMinor: number;
  /** KES lost to the rate margin compared with converting at mid. */
  marginCostKesMinor: number;
  totalCostKesMinor: number;
  offeredForeignPerKes: number;
}

export function offeredRate(midKesPerUnit: number, marginPct: number): number {
  return (1 / midKesPerUnit) * (1 - marginPct);
}

export function quoteSend(sendKesMinor: number, route: Route, midKesPerUnit: number): SendQuote {
  const fee = route.feeFixedMinor + Math.round(sendKesMinor * route.feePct);
  const net = Math.max(sendKesMinor - fee, 0);
  const rOff = offeredRate(midKesPerUnit, route.fxMarginPct);
  const received = Math.floor(net * rOff);
  // What the same net KES would buy at mid, minus what it buys here, in KES.
  const marginCost = Math.round(net - received * midKesPerUnit);
  return {
    routeId: route.id,
    sendKesMinor,
    feeKesMinor: fee,
    receivedMinor: received,
    marginCostKesMinor: Math.max(marginCost, 0),
    totalCostKesMinor: fee + Math.max(marginCost, 0),
    offeredForeignPerKes: rOff,
  };
}

/** The smallest KES amount that delivers at least `targetMinor` on a route. */
export function quoteReceive(targetMinor: number, route: Route, midKesPerUnit: number): SendQuote {
  const rOff = offeredRate(midKesPerUnit, route.fxMarginPct);
  let send = Math.ceil((targetMinor / rOff + route.feeFixedMinor) / (1 - route.feePct));
  let q = quoteSend(send, route, midKesPerUnit);
  // Rounding can leave the payee a cent short; step up until it is whole.
  while (q.receivedMinor < targetMinor) {
    send += 1;
    q = quoteSend(send, route, midKesPerUnit);
  }
  return q;
}

export interface RankedRoute {
  route: Route;
  quote: SendQuote;
  eligible: boolean;
  reasons: string[];
}

/**
 * Rank routes for a fixed amount to deliver. Ineligible routes are kept,
 * with reasons, so the student can see why a cheaper route was left out.
 */
export function compareRoutes(
  targetMinor: number,
  toCurrency: string,
  routes: Route[],
  midKesPerUnit: number,
  studentDocuments: string[],
): RankedRoute[] {
  const ranked = routes
    .filter((r) => r.toCurrency === toCurrency)
    .map((route) => {
      const quote = quoteReceive(targetMinor, route, midKesPerUnit);
      const reasons: string[] = [];
      if (quote.sendKesMinor > route.maxSendMinor) reasons.push('Amount is over this route\'s limit');
      if (quote.sendKesMinor < route.minSendMinor) reasons.push('Amount is under this route\'s minimum');
      for (const doc of route.requires) {
        if (!studentDocuments.includes(doc)) reasons.push(`Needs ${doc.replace(/_/g, ' ')}`);
      }
      return { route, quote, eligible: reasons.length === 0, reasons };
    });
  // Cheapest to send for the same delivered amount first; arrival time breaks ties.
  return ranked.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      a.quote.sendKesMinor - b.quote.sendKesMinor ||
      a.route.arrivalHours - b.route.arrivalHours,
  );
}
