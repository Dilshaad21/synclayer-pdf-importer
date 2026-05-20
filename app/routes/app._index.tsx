import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import OpenAI from "openai";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, PREMIUM_PLAN } from "../shopify.server";

// ─── Types ───────────────────────────────────────────────────────────────────

type ParsedItem = { sku: string; quantity: number };

type ParseResult =
  | { intent: "parse"; items: ParsedItem[]; fileName: string }
  | { intent: "parse"; error: string };

type SyncResult =
  | { success: true; sku: string; message: string }
  | { success: false; sku: string; error: string };

type BatchItemResult =
  | { sku: string; quantity: number; status: "success"; newStock: number | null }
  | { sku: string; quantity: number; status: "not_found" }
  | { sku: string; quantity: number; status: "error"; error: string };

type BatchResult = { intent: "batch"; results: BatchItemResult[] };

const MAX_FILE_BYTES = 4 * 1024 * 1024;

// ─── Type guards ─────────────────────────────────────────────────────────────

function isParseOk(
  d: ParseResult | undefined,
): d is { intent: "parse"; items: ParsedItem[]; fileName: string } {
  return !!d && "items" in d;
}

function isParseError(
  d: ParseResult | undefined,
): d is { intent: "parse"; error: string } {
  return !!d && "error" in d;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // billing types narrow to `never` due to a pre-existing dual shopify-api package
  // version conflict in PrismaSessionStorage — safe to cast, runtime is correct.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { billing } = (await authenticate.admin(request)) as any;
  await billing.require({
    plans: [PREMIUM_PLAN],
    isTest: true,
    onFailure: async () => billing.request({ plan: PREMIUM_PLAN, isTest: true }),
  });
  return null;
};

// ─── Action helpers ───────────────────────────────────────────────────────────

type AdminApi = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

async function lookupInventoryIds(
  admin: AdminApi,
  sku: string,
): Promise<{ inventoryItemId: string; locationId: string } | null> {
  const res = await admin.graphql(
    `#graphql
    query FindVariantBySku($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            inventoryItem {
              id
              inventoryLevels(first: 1) {
                edges {
                  node { location { id } }
                }
              }
            }
          }
        }
      }
    }`,
    { variables: { query: `sku:${sku}` } },
  );
  const json = await res.json();
  const edges: Array<{
    node: {
      inventoryItem: {
        id: string;
        inventoryLevels: { edges: Array<{ node: { location: { id: string } } }> };
      };
    };
  }> = json.data?.productVariants?.edges ?? [];
  if (!edges.length) return null;
  const inventoryItemId = edges[0]?.node?.inventoryItem?.id;
  const locationId =
    edges[0]?.node?.inventoryItem?.inventoryLevels?.edges?.[0]?.node?.location?.id;
  if (!inventoryItemId || !locationId) return null;
  return { inventoryItemId, locationId };
}

async function adjustInventory(
  admin: AdminApi,
  inventoryItemId: string,
  locationId: string,
  delta: number,
): Promise<{ newStock: number | null; userErrors: Array<{ message: string }> }> {
  const res = await admin.graphql(
    `#graphql
    mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors { field message }
        inventoryAdjustmentGroup {
          changes { delta quantityAfterChange }
        }
      }
    }`,
    {
      variables: {
        input: {
          name: "available",
          reason: "correction",
          changes: [{ inventoryItemId, locationId, delta }],
        },
      },
    },
  );
  const json = await res.json();
  const userErrors: Array<{ message: string }> =
    json.data?.inventoryAdjustQuantities?.userErrors ?? [];
  const newStock: number | null =
    json.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup
      ?.changes?.[0]?.quantityAfterChange ?? null;
  return { newStock, userErrors };
}

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ParseResult | SyncResult | BatchResult> => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "parse");

  // ── sync_inventory (single row) ────────────────────────────────────────────
  if (intent === "sync_inventory") {
    const sku = String(formData.get("sku") ?? "").trim();
    const quantity = Number(formData.get("quantity") ?? 0);

    console.log("🚀 SERVER SYNC (single) SKU:", sku, "QTY:", quantity);

    if (!sku || quantity <= 0) {
      return { success: false, sku, error: "Invalid SKU or quantity value." };
    }

    const ids = await lookupInventoryIds(admin, sku);
    if (!ids) {
      return {
        success: false,
        sku,
        error: `SKU "${sku}" was not found in your Shopify catalog.`,
      };
    }

    const { newStock, userErrors } = await adjustInventory(
      admin,
      ids.inventoryItemId,
      ids.locationId,
      quantity,
    );

    if (userErrors.length > 0) {
      console.log("❌ userErrors:", userErrors);
      return { success: false, sku, error: userErrors.map((e) => e.message).join(". ") };
    }

    console.log("✅ Single sync done. New stock:", newStock, "SKU:", sku);
    return {
      success: true,
      sku,
      message: `Inventory synced! Added ${quantity} units. New stock: ${newStock ?? "updated"}.`,
    };
  }

  // ── sync_all (batch) ───────────────────────────────────────────────────────
  if (intent === "sync_all") {
    let items: ParsedItem[] = [];
    try {
      items = JSON.parse(String(formData.get("items") ?? "[]")) as ParsedItem[];
    } catch {
      return { intent: "batch", results: [] };
    }

    console.log("🚀 BATCH SYNC — processing", items.length, "items");
    const results: BatchItemResult[] = [];

    for (const { sku, quantity } of items) {
      const ids = await lookupInventoryIds(admin, sku);

      if (!ids) {
        console.log("  ✗ not found:", sku);
        results.push({ sku, quantity, status: "not_found" });
        continue;
      }

      const { newStock, userErrors } = await adjustInventory(
        admin,
        ids.inventoryItemId,
        ids.locationId,
        quantity,
      );

      if (userErrors.length > 0) {
        console.log("  ✗ error for SKU:", sku, userErrors);
        results.push({
          sku,
          quantity,
          status: "error",
          error: userErrors.map((e) => e.message).join(". "),
        });
        continue;
      }

      console.log("  ✓ synced:", sku, "new stock:", newStock);
      results.push({ sku, quantity, status: "success", newStock });
    }

    console.log("🏁 BATCH COMPLETE:", results.map((r) => r.status).join(", "));
    return { intent: "batch", results };
  }

  // ── parse (default) ────────────────────────────────────────────────────────
  const file = formData.get("pdf");

  if (!(file instanceof File)) {
    return { intent: "parse", error: "No file received. Please try again." };
  }
  if (file.type !== "application/pdf") {
    return { intent: "parse", error: "Only PDF files are accepted. Please upload a .pdf file." };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { intent: "parse", error: "File exceeds the 4 MB limit. Please use a smaller PDF." };
  }

  const base64Pdf = Buffer.from(await file.arrayBuffer()).toString("base64");
  const pdfDataUrl = `data:application/pdf;base64,${base64Pdf}`;

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "You are a precise data extraction assistant. Extract product line items from supplier invoices and catalogs.",
        },
        {
          role: "user",
          content: [
            { type: "file", file: { filename: file.name, file_data: pdfDataUrl } },
            {
              type: "text",
              text: "Extract every product SKU and its ordered quantity from the supplier document above.",
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "invoice_line_items",
          strict: true,
          schema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    sku: { type: "string" },
                    quantity: { type: "integer" },
                  },
                  required: ["sku", "quantity"],
                  additionalProperties: false,
                },
              },
            },
            required: ["items"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return { intent: "parse", error: "OpenAI returned an empty response." };

    const result = JSON.parse(content) as { items: ParsedItem[] };
    return { intent: "parse", items: result.items, fileName: file.name };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { intent: "parse", error: `AI parsing failed: ${msg}` };
  }
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function PdfImporter() {
  const pdfFetcher = useFetcher<ParseResult>();
  const syncFetcher = useFetcher<SyncResult>();
  const batchFetcher = useFetcher<BatchResult>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // UI state driven from fetcher data but owned locally so reset can clear them
  const [parsedItems, setParsedItems] = useState<ParsedItem[] | null>(null);
  const [parsedFileName, setParsedFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [syncedSkus, setSyncedSkus] = useState<Set<string>>(new Set());
  const [batchResults, setBatchResults] = useState<BatchItemResult[] | null>(null);

  const isUploading = pdfFetcher.state !== "idle";
  const isAnySyncing = syncFetcher.state !== "idle";
  const isBatchSyncing = batchFetcher.state !== "idle";
  const syncingSkuNow = syncFetcher.formData?.get("sku") as string | null;

  const unsynced = parsedItems?.filter((item) => !syncedSkus.has(item.sku)) ?? [];

  // Sync parsed PDF data into local state
  useEffect(() => {
    if (isParseOk(pdfFetcher.data)) {
      setParsedItems(pdfFetcher.data.items);
      setParsedFileName(pdfFetcher.data.fileName);
      setParseError(null);
      setSyncedSkus(new Set());
      setBatchResults(null);
    } else if (isParseError(pdfFetcher.data)) {
      setParseError(pdfFetcher.data.error);
      setParsedItems(null);
    }
  }, [pdfFetcher.data]);

  // Track individually synced rows
  useEffect(() => {
    if (syncFetcher.state === "idle" && syncFetcher.data?.success === true) {
      setSyncedSkus((prev) => new Set([...prev, syncFetcher.data!.sku]));
    }
  }, [syncFetcher.state, syncFetcher.data]);

  // Capture batch results and mark successful SKUs as synced
  useEffect(() => {
    if (batchFetcher.state === "idle" && batchFetcher.data?.intent === "batch") {
      setBatchResults(batchFetcher.data.results);
      const succeeded = batchFetcher.data.results
        .filter((r) => r.status === "success")
        .map((r) => r.sku);
      setSyncedSkus((prev) => new Set([...prev, ...succeeded]));
    }
  }, [batchFetcher.state, batchFetcher.data]);

  function submitFile(file: File) {
    const fd = new FormData();
    fd.append("intent", "parse");
    fd.append("pdf", file);
    pdfFetcher.submit(fd, { method: "POST", encType: "multipart/form-data" });
  }

  function openPicker() {
    if (!isUploading) fileInputRef.current?.click();
  }

  function syncAll() {
    if (!unsynced.length) return;
    batchFetcher.submit(
      { items: JSON.stringify(unsynced), intent: "sync_all" },
      { method: "POST" },
    );
  }

  function reset() {
    setParsedItems(null);
    setParsedFileName(null);
    setParseError(null);
    setSyncedSkus(new Set());
    setBatchResults(null);
  }

  const successCount = batchResults?.filter((r) => r.status === "success").length ?? 0;
  const problemItems = batchResults?.filter(
    (r): r is Extract<BatchItemResult, { status: "not_found" | "error" }> =>
      r.status === "not_found" || r.status === "error",
  ) ?? [];

  const hasContent = parsedItems !== null || batchResults !== null || parseError !== null;

  return (
    <s-page heading="PDF Invoice Importer">

      {/* ── Upload Section ──────────────────────────────────────────────── */}
      <s-section heading="Upload Supplier PDF Invoice">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) submitFile(f);
            e.target.value = "";
          }}
        />

        <div
          role="button"
          tabIndex={0}
          aria-label="Drop a PDF here or click to choose a file"
          onClick={openPicker}
          onKeyDown={(e) => e.key === "Enter" && openPicker()}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const f = e.dataTransfer.files[0];
            if (f && !isUploading) submitFile(f);
          }}
          style={{
            border: `2px dashed ${isDragging ? "#005bd3" : "#babfc3"}`,
            borderRadius: "8px",
            padding: "48px 24px",
            textAlign: "center",
            background: isDragging ? "#f1f8fe" : "#fafbfb",
            cursor: isUploading ? "default" : "pointer",
            transition: "border-color 0.15s ease, background 0.15s ease",
          }}
        >
          {isUploading ? (
            <s-paragraph>Analysing PDF with OpenAI…</s-paragraph>
          ) : (
            <>
              <s-heading>Drop your PDF here</s-heading>
              <s-paragraph>or click to browse — PDF only, max 4 MB</s-paragraph>
            </>
          )}
        </div>

        <div style={{ marginTop: "12px" }}>
          <s-button onClick={openPicker} {...(isUploading ? { loading: true } : {})}>
            Choose File
          </s-button>
        </div>
      </s-section>

      {/* ── Parse error ─────────────────────────────────────────────────── */}
      {parseError && (
        <s-section heading="Upload Error">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <span>{parseError}</span>
          </s-box>
        </s-section>
      )}

      {/* ── Individual sync banners (gated on active session) ────────────── */}
      {parsedItems !== null && syncFetcher.data?.success === true && (
        <s-section heading="Row Synced">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <span style={{ color: "#008060", fontWeight: 500 }}>
              ✓ {syncFetcher.data.message}
            </span>
          </s-box>
        </s-section>
      )}

      {parsedItems !== null && syncFetcher.data?.success === false && (
        <s-section heading="Sync Failed">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <span style={{ color: "#d72c0d" }}>{syncFetcher.data.error}</span>
          </s-box>
        </s-section>
      )}

      {/* ── Batch results summary ────────────────────────────────────────── */}
      {batchResults !== null && (
        <>
          <s-section heading="Batch Sync Complete">
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <span style={{ color: "#008060", fontWeight: 500, fontSize: "15px" }}>
                ✓ {successCount} of {batchResults.length} item
                {batchResults.length !== 1 ? "s" : ""} successfully synced to Shopify inventory.
              </span>
            </s-box>
          </s-section>

          {problemItems.length > 0 && (
            <s-section heading={`Missing SKUs — ${problemItems.length} item${problemItems.length !== 1 ? "s" : ""} need attention`}>
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <div style={{ marginBottom: "10px" }}>
                  <span style={{ color: "#916a00", fontWeight: 500 }}>
                    ⚠ These SKUs could not be matched in your Shopify catalog.
                    Create or correct the products in Shopify Admin, then re-import this invoice.
                  </span>
                </div>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "13px",
                    fontFamily: "inherit",
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                      <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600 }}>SKU</th>
                      <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 600 }}>Qty</th>
                      <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600 }}>Issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {problemItems.map((item, i) => (
                      <tr
                        key={`${item.sku}-${i}`}
                        style={{ borderBottom: "1px solid #e1e3e5", background: "#fdf6e3" }}
                      >
                        <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>{item.sku}</td>
                        <td style={{ padding: "8px 12px", textAlign: "right" }}>{item.quantity}</td>
                        <td style={{ padding: "8px 12px", color: "#916a00" }}>
                          {item.status === "error" ? item.error : "SKU not found in catalog"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </s-box>
            </s-section>
          )}
        </>
      )}

      {/* ── Results table + sync actions ─────────────────────────────────── */}
      {parsedItems !== null && (
        <s-section heading={`Parsed Items${parsedFileName ? ` — ${parsedFileName}` : ""}`}>
          <s-paragraph>
            {parsedItems.length} line item{parsedItems.length !== 1 ? "s" : ""} extracted.
            Approve rows individually or sync all at once — no inventory changes are made
            automatically.
          </s-paragraph>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "13px",
                fontFamily: "inherit",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600 }}>SKU</th>
                  <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 600 }}>Qty</th>
                  <th style={{ textAlign: "center", padding: "8px 12px", fontWeight: 600 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {parsedItems.map((item, i) => {
                  const alreadySynced = syncedSkus.has(item.sku);
                  const isSyncingThis = syncingSkuNow === item.sku;

                  return (
                    <tr
                      key={`${item.sku}-${i}`}
                      style={{
                        borderBottom: "1px solid #e1e3e5",
                        background: alreadySynced
                          ? "rgba(0, 128, 96, 0.06)"
                          : i % 2
                          ? "rgba(0,0,0,0.02)"
                          : "transparent",
                      }}
                    >
                      <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>
                        {item.sku}
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>
                        {item.quantity}
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "center" }}>
                        {alreadySynced ? (
                          <span style={{ color: "#008060", fontWeight: 500 }}>✓ Synced</span>
                        ) : (
                          <s-button
                            onClick={() =>
                              syncFetcher.submit(
                                {
                                  sku: item.sku,
                                  quantity: String(item.quantity),
                                  intent: "sync_inventory",
                                },
                                { method: "POST" },
                              )
                            }
                            {...(isSyncingThis ? { loading: true } : {})}
                            {...((isAnySyncing && !isSyncingThis) || isBatchSyncing
                              ? { disabled: true }
                              : {})}
                          >
                            Approve &amp; Sync
                          </s-button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </s-box>

          <div style={{ marginTop: "16px", display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
            {unsynced.length > 0 ? (
              <s-button
                onClick={syncAll}
                {...(isBatchSyncing ? { loading: true } : {})}
                {...(isAnySyncing ? { disabled: true } : {})}
              >
                Sync All {unsynced.length} Remaining Item{unsynced.length !== 1 ? "s" : ""}
              </s-button>
            ) : (
              <span style={{ color: "#008060", fontWeight: 500 }}>✓ All items synced</span>
            )}

            {hasContent && (
              <s-button onClick={reset}>
                Clear &amp; Upload Next Invoice
              </s-button>
            )}
          </div>
        </s-section>
      )}

      {/* ── Reset when only error or batch summary is showing ────────────── */}
      {hasContent && parsedItems === null && (
        <s-section heading="Next Invoice">
          <s-button onClick={reset}>
            Clear &amp; Upload Next Invoice
          </s-button>
        </s-section>
      )}

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
