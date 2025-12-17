import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { GenerateRequest, GenerateResponse, ModelType } from "@/types";

export const maxDuration = 300; // 5 minute timeout for Gemini API calls
export const dynamic = 'force-dynamic'; // Ensure this route is always dynamic

// Map model types to Gemini model IDs (GoogleGenAI / direct Gemini)
const GEMINI_MODEL_MAP: Record<ModelType, string> = {
  "nano-banana": "gemini-2.5-flash-image", // Updated to correct model name
  "nano-banana-pro": "gemini-3-pro-image-preview",
};

// Map model types to OpenRouter model IDs
const OPENROUTER_MODEL_MAP: Record<ModelType, string> = {
  "nano-banana": "google/gemini-2.5-flash-image",
  "nano-banana-pro": "google/gemini-3-pro-image-preview",
};

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

function buildDataUrl(mimeType: string, base64Data: string): string {
  return `data:${mimeType};base64,${base64Data}`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`\n[API:${requestId}] ========== NEW GENERATE REQUEST ==========`);
  console.log(`[API:${requestId}] Timestamp: ${new Date().toISOString()}`);

  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const openRouterApiKey = process.env.OPEN_ROUTER_API_KEY;

    const provider = geminiApiKey
      ? "gemini"
      : (openRouterApiKey ? "openrouter" : null);
    console.log(`[API:${requestId}] Provider selection: ${provider || "none"}`);

    if (!provider) {
      console.error(`[API:${requestId}] ❌ No API key configured`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error:
            "API key not configured. Add GEMINI_API_KEY or OPEN_ROUTER_API_KEY to .env.local",
        },
        { status: 500 }
      );
    }

    console.log(`[API:${requestId}] Parsing request body...`);
    const body: GenerateRequest = await request.json();
    const {
      images,
      prompt,
      model = "nano-banana-pro",
      aspectRatio,
      resolution,
      useGoogleSearch,
    } = body;

    console.log(`[API:${requestId}] Request parameters:`);
    const modelIdForLog = provider === "gemini"
      ? GEMINI_MODEL_MAP[model]
      : OPENROUTER_MODEL_MAP[model];
    console.log(`[API:${requestId}]   - Model: ${model} -> ${modelIdForLog}`);
    console.log(`[API:${requestId}]   - Images count: ${images?.length || 0}`);
    console.log(`[API:${requestId}]   - Prompt length: ${prompt?.length || 0} chars`);
    console.log(`[API:${requestId}]   - Aspect Ratio: ${aspectRatio || 'default'}`);
    console.log(`[API:${requestId}]   - Resolution: ${resolution || 'default'}`);
    console.log(`[API:${requestId}]   - Google Search: ${useGoogleSearch || false}`);

    if (!images || images.length === 0 || !prompt) {
      console.error(`[API:${requestId}] ❌ Validation failed: missing images or prompt`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "At least one image and prompt are required",
        },
        { status: 400 }
      );
    }

    console.log(`[API:${requestId}] Extracting image data...`);
    // Extract base64 data and MIME types from data URLs
    const imageData = images.map((image, idx) => {
      if (image.includes("base64,")) {
        const [header, data] = image.split("base64,");
        // Extract MIME type from header (e.g., "data:image/png;" -> "image/png")
        const mimeMatch = header.match(/data:([^;]+)/);
        const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
        console.log(`[API:${requestId}]   Image ${idx + 1}: ${mimeType}, ${(data.length / 1024).toFixed(2)}KB base64`);
        return { data, mimeType };
      }
      console.log(`[API:${requestId}]   Image ${idx + 1}: No base64 header, assuming PNG, ${(image.length / 1024).toFixed(2)}KB`);
      return { data: image, mimeType: "image/png" };
    });

    if (provider === "gemini") {
      // Initialize Gemini client
      console.log(`[API:${requestId}] Initializing Gemini client...`);
      const ai = new GoogleGenAI({ apiKey: geminiApiKey as string });

      // Build request parts array with prompt and all images
      console.log(`[API:${requestId}] Building request parts...`);
      const requestParts: Array<
        { text: string } | { inlineData: { mimeType: string; data: string } }
      > = [
        { text: prompt },
        ...imageData.map(({ data, mimeType }) => ({
          inlineData: {
            mimeType,
            data,
          },
        })),
      ];
      console.log(
        `[API:${requestId}] Request parts count: ${requestParts.length} (1 text + ${imageData.length} images)`
      );

      // Build config object based on model capabilities
      console.log(`[API:${requestId}] Building generation config...`);
      const config: any = {
        responseModalities: ["IMAGE", "TEXT"],
      };

      // Add imageConfig for both models (both support aspect ratio)
      if (aspectRatio) {
        config.imageConfig = {
          aspectRatio,
        };
        console.log(`[API:${requestId}]   Added aspect ratio: ${aspectRatio}`);
      }

      // Add resolution only for Nano Banana Pro
      if (model === "nano-banana-pro" && resolution) {
        if (!config.imageConfig) {
          config.imageConfig = {};
        }
        config.imageConfig.imageSize = resolution;
        console.log(`[API:${requestId}]   Added resolution: ${resolution}`);
      }

      // Add tools array for Google Search (only Nano Banana Pro)
      const tools = [];
      if (model === "nano-banana-pro" && useGoogleSearch) {
        tools.push({ googleSearch: {} });
        console.log(`[API:${requestId}]   Added Google Search tool`);
      }

      console.log(`[API:${requestId}] Final config:`, JSON.stringify(config, null, 2));
      if (tools.length > 0) {
        console.log(`[API:${requestId}] Tools:`, JSON.stringify(tools, null, 2));
      }

      // Make request to Gemini
      console.log(`[API:${requestId}] Calling Gemini API...`);
      const geminiStartTime = Date.now();

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL_MAP[model],
        contents: [
          {
            role: "user",
            parts: requestParts,
          },
        ],
        config,
        ...(tools.length > 0 && { tools }),
      });

      const geminiDuration = Date.now() - geminiStartTime;
      console.log(`[API:${requestId}] Gemini API call completed in ${geminiDuration}ms`);

      // Extract image from response
      console.log(`[API:${requestId}] Processing response...`);
      const candidates = response.candidates;
      console.log(`[API:${requestId}] Candidates count: ${candidates?.length || 0}`);

      if (!candidates || candidates.length === 0) {
        console.error(`[API:${requestId}] ❌ No candidates in response`);
        console.error(`[API:${requestId}] Full response:`, JSON.stringify(response, null, 2));
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "No response from AI model",
          },
          { status: 500 }
        );
      }

      const parts = candidates[0].content?.parts;
      console.log(`[API:${requestId}] Parts count in first candidate: ${parts?.length || 0}`);

      if (!parts) {
        console.error(`[API:${requestId}] ❌ No parts in candidate content`);
        console.error(`[API:${requestId}] Candidate:`, JSON.stringify(candidates[0], null, 2));
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "No content in response",
          },
          { status: 500 }
        );
      }

      // Log all parts
      parts.forEach((part, idx) => {
        const partKeys = Object.keys(part);
        console.log(`[API:${requestId}] Part ${idx + 1}: ${partKeys.join(", ")}`);
      });

      // Find image part in response
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) {
          const mimeType = part.inlineData.mimeType || "image/png";
          const imageData = part.inlineData.data;
          const imageSizeKB = (imageData.length / 1024).toFixed(2);
          console.log(
            `[API:${requestId}] ✓ Found image in response: ${mimeType}, ${imageSizeKB}KB base64`
          );

          const dataUrl = buildDataUrl(mimeType, imageData);
          const dataUrlSizeKB = (dataUrl.length / 1024).toFixed(2);
          console.log(`[API:${requestId}] Data URL size: ${dataUrlSizeKB}KB`);

          const responsePayload = { success: true, image: dataUrl };
          const responseSize = JSON.stringify(responsePayload).length;
          const responseSizeMB = (responseSize / (1024 * 1024)).toFixed(2);
          console.log(`[API:${requestId}] Total response payload size: ${responseSizeMB}MB`);

          if (responseSize > 4.5 * 1024 * 1024) {
            console.warn(
              `[API:${requestId}] ⚠️ Response size (${responseSizeMB}MB) is approaching Next.js 5MB limit!`
            );
          }

          console.log(`[API:${requestId}] ✓✓✓ SUCCESS - Returning image ✓✓✓`);

          // Create response with explicit headers to handle large payloads
          const response = NextResponse.json<GenerateResponse>(responsePayload);
          response.headers.set("Content-Type", "application/json");
          response.headers.set("Content-Length", responseSize.toString());

          console.log(`[API:${requestId}] Response headers set, returning...`);
          return response;
        }
      }

      // If no image found, check for text error
      console.warn(`[API:${requestId}] ⚠ No image found in parts, checking for text...`);
      for (const part of parts) {
        if (part.text) {
          console.error(`[API:${requestId}] ❌ Model returned text instead of image`);
          console.error(`[API:${requestId}] Text preview: "${part.text.substring(0, 200)}"`);
          return NextResponse.json<GenerateResponse>(
            {
              success: false,
              error: `Model returned text instead of image: ${part.text.substring(0, 200)}`,
            },
            { status: 500 }
          );
        }
      }

      console.error(`[API:${requestId}] ❌ No image or text found in response`);
      console.error(`[API:${requestId}] All parts:`, JSON.stringify(parts, null, 2));
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "No image in response",
        },
        { status: 500 }
      );
    }

    // ===== OpenRouter path =====
    console.log(`[API:${requestId}] Calling OpenRouter API...`);
    const openRouterStartTime = Date.now();

    const contentParts = [
      { type: "text", text: prompt },
      ...imageData.map(({ data, mimeType }) => ({
        type: "image_url",
        image_url: {
          url: buildDataUrl(mimeType, data),
        },
      })),
    ];

    const openRouterPayload: any = {
      model: OPENROUTER_MODEL_MAP[model],
      messages: [
        {
          role: "user",
          content: contentParts,
        },
      ],
      modalities: ["image", "text"],
    };

    if (aspectRatio || (model === "nano-banana-pro" && resolution)) {
      openRouterPayload.image_config = {};
      if (aspectRatio) {
        openRouterPayload.image_config.aspect_ratio = aspectRatio;
        console.log(`[API:${requestId}]   [OpenRouter] Added aspect ratio: ${aspectRatio}`);
      }
      if (model === "nano-banana-pro" && resolution) {
        openRouterPayload.image_config.image_size = resolution;
        console.log(`[API:${requestId}]   [OpenRouter] Added resolution: ${resolution}`);
      }
    }

    if (model === "nano-banana-pro" && useGoogleSearch) {
      // OpenRouter web search grounding (maps to existing "useGoogleSearch" UX)
      openRouterPayload.plugins = [{ id: "web" }];
      console.log(`[API:${requestId}]   [OpenRouter] Enabled web search plugin`);
    }

    console.log(
      `[API:${requestId}] OpenRouter payload summary:`,
      JSON.stringify(
        {
          model: openRouterPayload.model,
          modalities: openRouterPayload.modalities,
          image_config: openRouterPayload.image_config,
          plugins: openRouterPayload.plugins,
          images: imageData.length,
          promptLength: prompt.length,
        },
        null,
        2
      )
    );

    const openRouterResponse = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openRouterApiKey as string}`,
      },
      body: JSON.stringify(openRouterPayload),
    });

    const openRouterDuration = Date.now() - openRouterStartTime;
    console.log(`[API:${requestId}] OpenRouter API call completed in ${openRouterDuration}ms`);

    if (!openRouterResponse.ok) {
      const errorText = await openRouterResponse.text();
      const errorJson = safeJsonParse(errorText) as any;
      const nestedMessage =
        errorJson && typeof errorJson === "object"
          ? errorJson?.error?.message || errorJson?.message || errorJson?.error
          : null;

      const status = openRouterResponse.status;
      const errorMessage =
        typeof nestedMessage === "string" && nestedMessage
          ? nestedMessage
          : `OpenRouter API error: ${status}`;

      console.error(`[API:${requestId}] ❌ OpenRouter error status: ${status}`);
      console.error(`[API:${requestId}] ❌ OpenRouter error body:`, errorText.substring(0, 2000));

      if (status === 429 || String(errorMessage).includes("429")) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "Rate limit reached. Please wait and try again.",
          },
          { status: 429 }
        );
      }

      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: errorMessage,
        },
        { status: 500 }
      );
    }

    const openRouterResult: any = await openRouterResponse.json();
    const choices = openRouterResult?.choices;
    console.log(`[API:${requestId}] OpenRouter choices count: ${choices?.length || 0}`);

    const message = choices?.[0]?.message;
    const imagesOut = message?.images;
    console.log(`[API:${requestId}] OpenRouter images count: ${imagesOut?.length || 0}`);

    if (Array.isArray(imagesOut) && imagesOut.length > 0) {
      const imageUrl = imagesOut?.[0]?.image_url?.url;

      if (typeof imageUrl !== "string" || !imageUrl) {
        console.error(`[API:${requestId}] ❌ OpenRouter image missing image_url.url`);
        console.error(`[API:${requestId}] OpenRouter first image:`, JSON.stringify(imagesOut[0], null, 2));
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "No image in response",
          },
          { status: 500 }
        );
      }

      const responsePayload = { success: true, image: imageUrl };
      const responseSize = JSON.stringify(responsePayload).length;
      const responseSizeMB = (responseSize / (1024 * 1024)).toFixed(2);
      console.log(`[API:${requestId}] Total response payload size: ${responseSizeMB}MB`);

      if (responseSize > 4.5 * 1024 * 1024) {
        console.warn(
          `[API:${requestId}] ⚠️ Response size (${responseSizeMB}MB) is approaching Next.js 5MB limit!`
        );
      }

      console.log(`[API:${requestId}] ✓✓✓ SUCCESS - Returning image ✓✓✓`);

      const response = NextResponse.json<GenerateResponse>(responsePayload);
      response.headers.set("Content-Type", "application/json");
      response.headers.set("Content-Length", responseSize.toString());
      return response;
    }

    const messageText = message?.content;
    if (typeof messageText === "string" && messageText.trim()) {
      const preview = messageText.substring(0, 200);
      console.error(`[API:${requestId}] ❌ Model returned text instead of image`);
      console.error(`[API:${requestId}] Text preview: "${preview}"`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: `Model returned text instead of image: ${preview}`,
        },
        { status: 500 }
      );
    }

    console.error(`[API:${requestId}] ❌ No image found in OpenRouter response`);
    console.error(`[API:${requestId}] OpenRouter response:`, JSON.stringify(openRouterResult, null, 2));
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "No image in response",
      },
      { status: 500 }
    );
  } catch (error) {
    const requestId = 'unknown'; // Fallback if we don't have it in scope
    console.error(`[API:${requestId}] ❌❌❌ EXCEPTION CAUGHT IN API ROUTE ❌❌❌`);
    console.error(`[API:${requestId}] Error type:`, error?.constructor?.name);
    console.error(`[API:${requestId}] Error toString:`, String(error));

    // Extract detailed error information
    let errorMessage = "Generation failed";
    let errorDetails = "";

    if (error instanceof Error) {
      errorMessage = error.message;
      errorDetails = error.stack || "";
      console.error(`[API:${requestId}] Error message:`, errorMessage);
      console.error(`[API:${requestId}] Error stack:`, error.stack);

      // Check for specific error types
      if ("cause" in error && error.cause) {
        console.error(`[API:${requestId}] Error cause:`, error.cause);
        errorDetails += `\nCause: ${JSON.stringify(error.cause)}`;
      }
    }

    // Try to extract more details from Google API errors
    if (error && typeof error === "object") {
      const apiError = error as Record<string, unknown>;
      console.error(`[API:${requestId}] Error object keys:`, Object.keys(apiError));

      if (apiError.status) {
        console.error(`[API:${requestId}] Error status:`, apiError.status);
        errorDetails += `\nStatus: ${apiError.status}`;
      }
      if (apiError.statusText) {
        console.error(`[API:${requestId}] Error statusText:`, apiError.statusText);
        errorDetails += `\nStatusText: ${apiError.statusText}`;
      }
      if (apiError.errorDetails) {
        console.error(`[API:${requestId}] Error errorDetails:`, apiError.errorDetails);
        errorDetails += `\nDetails: ${JSON.stringify(apiError.errorDetails)}`;
      }
      if (apiError.response) {
        try {
          console.error(`[API:${requestId}] Error response:`, apiError.response);
          errorDetails += `\nResponse: ${JSON.stringify(apiError.response)}`;
        } catch {
          errorDetails += `\nResponse: [unable to stringify]`;
        }
      }

      // Log entire error object for debugging
      try {
        console.error(`[API:${requestId}] Full error object:`, JSON.stringify(apiError, null, 2));
      } catch {
        console.error(`[API:${requestId}] Could not stringify full error object`);
      }
    }

    console.error(`[API:${requestId}] Compiled error details:`, errorDetails);

    // Handle rate limiting
    if (errorMessage.includes("429")) {
      console.error(`[API:${requestId}] Rate limit error detected`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "Rate limit reached. Please wait and try again.",
        },
        { status: 429 }
      );
    }

    console.error(`[API:${requestId}] Returning 500 error response`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: `${errorMessage}${errorDetails ? ` | Details: ${errorDetails.substring(0, 500)}` : ""}`,
      },
      { status: 500 }
    );
  }
}
