import { protect, body, publicConfig, safeError } from "@/lib/server/security";
import { forwardRpc } from "@/lib/server/rpc";
import { modelAction } from "@/lib/server/models";
import { price } from "@/lib/server/price";
import { operatorAction } from "@/lib/server/operator";
export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  try {
    protect(request);
    const { action } = await context.params;
    const input = await body(request, action === "rpc" ? 65536 : 1024 * 1024);
    if (action === "rpc") return await forwardRpc(input);
    if (action === "operator")
      return Response.json(await operatorAction(input), {
        headers: { "Cache-Control": "no-store" },
      });
    const result =
      action === "config"
        ? publicConfig()
        : action === "price"
          ? await price()
          : action === "model"
            ? await modelAction(input)
            : null;
    if (result === null)
      return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: safeError(e) },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
