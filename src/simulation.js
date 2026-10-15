import { ammOut } from "./math.js";

function snapshot(pool) {
  const reserveBase = BigInt(pool.reserveBaseRaw);
  const reserveQuote = BigInt(pool.reserveQuoteRaw);
  return { reserveBase, reserveQuote, invariant: reserveBase * reserveQuote };
}

export function simulateConstantProductPlan(sources, scan) {
  if (!scan.plan || !scan.bestRoute) return null;
  const route = scan.routes.find((candidate) => candidate.route === scan.bestRoute);
  const buy = sources.find((source) => source.id === route.buySource);
  const sell = sources.find((source) => source.id === route.sellSource);
  const buyBefore = snapshot(buy);
  const sellBefore = snapshot(sell);
  const input = BigInt(route.inputRaw);
  const intermediate = ammOut(input, buyBefore.reserveQuote, buyBefore.reserveBase, BigInt(buy.feeBps));
  const buyAfter = {
    reserveBase: buyBefore.reserveBase - intermediate,
    reserveQuote: buyBefore.reserveQuote + input,
  };
  buyAfter.invariant = buyAfter.reserveBase * buyAfter.reserveQuote;
  const output = ammOut(intermediate, sellBefore.reserveBase, sellBefore.reserveQuote, BigInt(sell.feeBps));
  const sellAfter = {
    reserveBase: sellBefore.reserveBase + intermediate,
    reserveQuote: sellBefore.reserveQuote - output,
  };
  sellAfter.invariant = sellAfter.reserveBase * sellAfter.reserveQuote;
  if (output.toString() !== route.afterFeeOutputRaw) throw new Error("Deterministic execution does not match scanner quote");
  return {
    label: "DETERMINISTIC LOCAL AMM EXECUTION — NO BLOCKCHAIN TRANSACTION",
    independentInstances: [buy.id, sell.id],
    inputRaw: input.toString(), intermediateRaw: intermediate.toString(), outputRaw: output.toString(),
    matchesScannerAfterFeeOutput: true,
    steps: [
      { venue: buy.id, operation: "quote token → base token", before: serialize(buyBefore), after: serialize(buyAfter) },
      { venue: sell.id, operation: "base token → quote token", before: serialize(sellBefore), after: serialize(sellAfter) },
    ],
  };
}

function serialize(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item.toString()]));
}
