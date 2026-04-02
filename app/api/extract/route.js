import { NextResponse } from "next/server";

const EXTRACTION_PROMPT = `You are analyzing an HSE inspection dashboard screenshot. Extract the following data precisely:

1. **Inspector email**: Found in the right panel next to "Inspector" label (e.g., naif.marzoki@jcd.com.sa)
2. **Date**: Found in the right panel next to "Date" label (e.g., 3/29/2026)
3. **Package/Location**: Found next to "Package" label (e.g., Oceanarium, Stadium, Opera House, Infra)
4. **Overall compliance %**: The percentage shown at the top of the right panel (e.g., "Partially Compliant - 98%")
5. **Category scores**: From the bar chart at the bottom. There are 20 categories. Each bar has a percentage label on top. Read left to right:
   - Permits To Work
   - PPE
   - Housekeeping
   - Environmental Compliance
   - Facilities Inspection
   - Cranes And Lifting Operations
   - General Site Safety
   - Site Supervision Compliance
   - Laydown Safety Compliance
   - Chemical Handling/Storage
   - Excavations
   - Fire Prevention/Protection And Hot Works
   - Traffic Safety Management
   - Marine
   - Confined Spaces
   - Fall Protection/Prevention Machine
   - Hand/Power Tools & Machine
   - Scaffolds & Ladders
   - Vehicles And Mobile Heavy
   - Electrical Compliance Equipment

Return ONLY valid JSON, no markdown fences, no explanation. Format:
{
  "inspector_email": "string",
  "inspector_name": "string (extract from email: first.last → First Last)",
  "date": "YYYY-MM-DD",
  "package": "string",
  "overall_compliance": number,
  "scores": {
    "permits_to_work": number,
    "ppe": number,
    "housekeeping": number,
    "environmental_compliance": number,
    "facilities_inspection": number,
    "cranes_and_lifting": number,
    "general_site_safety": number,
    "site_supervision": number,
    "laydown_safety": number,
    "chemical_handling": number,
    "excavations": number,
    "fire_prevention": number,
    "traffic_safety": number,
    "marine": number,
    "confined_spaces": number,
    "fall_protection": number,
    "hand_power_tools": number,
    "scaffolds_ladders": number,
    "vehicles_mobile_heavy": number,
    "electrical_compliance": number
  }
}`;

export async function POST(request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 }
    );
  }

  try {
    const { image, mediaType } = await request.json();

    if (!image) {
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType || "image/png",
                  data: image,
                },
              },
              { type: "text", text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json(
        { error: `Anthropic API error: ${response.status} — ${errText}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    const text = data.content?.map((c) => c.text || "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    return NextResponse.json(
      { error: `Extraction failed: ${err.message}` },
      { status: 500 }
    );
  }
}
