/** Packs complete original tensor rows. Slices begin on fresh pages, so routed
 * expert selection is a fixed public stride and never a coordinator choice. */
import type { PublicModelPlan, PublicTensor } from "./model";
export const WEIGHT_PAGE_BYTES = 8192;
export type PackedTensor = {
  tensor: PublicTensor;
  basePage: number;
  rowsPerPage: number;
  pagesPerSlice: number;
};
export type PackedWeights = {
  pages: Uint8Array[];
  tensors: Map<string, PackedTensor>;
};
export function packWeights(
  plan: PublicModelPlan,
  bytes: Uint8Array,
): PackedWeights {
  const pages: Uint8Array[] = [],
    tensors = new Map<string, PackedTensor>();
  for (const tensor of plan.tensors) {
    if (
      !Number.isSafeInteger(tensor.rowBytes) ||
      tensor.rowBytes < 1 ||
      tensor.rowBytes > WEIGHT_PAGE_BYTES ||
      tensor.offset < 0 ||
      tensor.offset + tensor.bytes > bytes.length ||
      tensor.rows * tensor.slices * tensor.rowBytes !== tensor.bytes ||
      tensors.has(tensor.name)
    )
      throw Error("public_weight_row_bounds");
    const rowsPerPage = Math.floor(WEIGHT_PAGE_BYTES / tensor.rowBytes),
      pagesPerSlice = Math.ceil(tensor.rows / rowsPerPage),
      basePage = pages.length;
    for (let slice = 0; slice < tensor.slices; slice++) {
      for (let row = 0; row < tensor.rows; row += rowsPerPage) {
        const count = Math.min(rowsPerPage, tensor.rows - row),
          offset =
            tensor.offset + (slice * tensor.rows + row) * tensor.rowBytes;
        pages.push(
          Uint8Array.from(
            bytes.subarray(offset, offset + count * tensor.rowBytes),
          ),
        );
      }
    }
    tensors.set(tensor.name, { tensor, basePage, rowsPerPage, pagesPerSlice });
  }
  return { pages, tensors };
}
export function packedRows(
  packed: PackedTensor,
  productsPerStep: number,
  maximumRows = 16,
): { row: number; count: number; page: number; offset: number }[] {
  const { tensor, rowsPerPage, basePage } = packed;
  const bound = Math.min(
    maximumRows,
    Math.floor(productsPerStep / tensor.rowElements),
  );
  if (!Number.isSafeInteger(bound) || bound < 1)
    throw Error("public_weight_step_bound");
  const chunks = [];
  for (let row = 0; row < tensor.rows;) {
    const pageRow = row % rowsPerPage,
      count = Math.min(bound, rowsPerPage - pageRow, tensor.rows - row);
    chunks.push({
      row,
      count,
      page: basePage + Math.floor(row / rowsPerPage),
      offset: pageRow * tensor.rowBytes,
    });
    row += count;
  }
  return chunks;
}
