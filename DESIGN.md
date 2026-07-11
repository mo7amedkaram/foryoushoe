---
name: "For You Shoe Operations"
description: "A clear Arabic-first order confirmation workspace."
colors:
  primary: "#1f6a49"
  primary-deep: "#16543a"
  primary-soft: "#e2f0e8"
  canvas: "#f5f7f4"
  surface: "#fbfcfa"
  surface-muted: "#eef2ed"
  text: "#17211b"
  text-muted: "#5f6d64"
  border: "#d5ddd6"
  info: "#315f86"
  warning: "#9a651d"
  danger: "#a33d45"
typography:
  headline:
    fontFamily: "Segoe UI, Tahoma, Arial, Noto Sans Arabic, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Segoe UI, Tahoma, Arial, Noto Sans Arabic, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: "Segoe UI, Tahoma, Arial, Noto Sans Arabic, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Segoe UI, Tahoma, Arial, Noto Sans Arabic, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
    height: "42px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
    height: "42px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "8px 11px"
    height: "42px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "24px"
---

# Design System: For You Shoe Operations

## 1. Overview

**Creative North Star: "The Clear Order Desk"**

This interface feels like a well-organized work surface at the center of a busy store: bright enough for daytime use, quiet enough for concentration, and structured around the next operational decision. Familiar product patterns make the system disappear into the order-confirmation task.

The system is calm, trustworthy, and efficient. It rejects the previous card-heavy setup wizard, arbitrary numbering, decorative dashboard clutter, excessive technical copy, and dark styling that made routine work feel like an incident console.

**Key Characteristics:**

- Arabic-first hierarchy with correct LTR treatment for identifiers.
- Operational views for overview, orders, activity, and settings.
- Restrained green accent reserved for actions and healthy status.
- Progressive disclosure for configuration and response detail.
- Responsive structure with reduced-motion support.

## 2. Colors

The palette uses botanical neutrals and one restrained green accent to feel grounded without borrowing WhatsApp's saturated visual identity.

### Primary

- **Ledger Green:** Primary actions, selected navigation, and healthy operational emphasis.
- **Deep Ledger:** Hover and high-emphasis text on soft green surfaces.
- **Receipt Mint:** Quiet success backgrounds and selected low-emphasis states.

### Secondary

- **Dispatch Blue:** Informational states that must remain distinct from success.
- **Parcel Amber:** Pending and attention states.
- **Exception Red:** Failures and destructive outcomes only.

### Neutral

- **Daylight Canvas:** The application background.
- **Paper Surface:** Primary working surfaces and controls.
- **Quiet Divider:** Toolbars, table headers, and secondary grouping.
- **Ink:** Primary text.
- **Archive Gray:** Supporting text and inactive controls.

### Named Rules

**The Ten Percent Rule.** Ledger Green occupies no more than ten percent of a routine screen and appears only for action, selection, or state.

**The Status Has Words Rule.** Success, pending, and failure always include a readable label or symbol; color never carries meaning alone.

## 3. Typography

**Display Font:** Segoe UI with Tahoma, Arial, Noto Sans Arabic, and system fallbacks  
**Body Font:** Segoe UI with the same Arabic-safe fallback stack  
**Label/Mono Font:** Cascadia Code or Consolas for identifiers only

**Character:** A single familiar sans-serif keeps dense Arabic product UI legible and trustworthy. Monospace is narrowly reserved for IDs, API values, and raw responses.

### Hierarchy

- **Headline** (700, 40px, 1.18): Page purpose on desktop; 26px on narrow screens.
- **Title** (700, 20px, 1.35): Panel and workflow headings.
- **Body** (400, 15px, 1.6): Explanations capped near 68 characters when prose is present.
- **Label** (700, 12px, 1.4): Form labels, eyebrows, table headings, and status metadata.

### Named Rules

**The One Family Rule.** UI labels, buttons, data, and headings use one sans-serif family; display type is prohibited.

## 4. Elevation

The system is flat by default. Borders and tonal surfaces establish structure; a low ambient shadow appears only on a primary working panel, and a stronger shadow is reserved for transient toast feedback.

### Shadow Vocabulary

- **Desk Lift** (`0 1px 2px` with low-opacity tinted ink): Primary working panels only.
- **Toast Float** (`0 18px 44px` with low-opacity tinted ink): Temporary system feedback only.

### Named Rules

**The Flat Desk Rule.** Surfaces at the same hierarchy never cast shadows on each other.

## 5. Components

### Buttons

- **Shape:** Compact, gently squared corners (6px) with a minimum height of 42px.
- **Primary:** Ledger Green with Paper Surface text and 9px by 16px padding.
- **Hover / Focus:** Darken one tonal step; use a visible three-pixel tinted focus ring.
- **Secondary / Ghost:** Paper Surface with a real border, or transparent for low-emphasis pagination.

### Chips

- **Style:** Small labeled pills on tinted semantic surfaces with a visible border.
- **State:** Selected filters move onto Paper Surface and add weight; unselected filters remain neutral.

### Cards / Containers

- **Corner Style:** Gently rounded (14px) only for a primary working panel.
- **Background:** Paper Surface over Daylight Canvas.
- **Shadow Strategy:** Desk Lift only; no nested elevation.
- **Border:** One-pixel Quiet Divider.
- **Internal Padding:** 24px desktop, 14px mobile.

### Inputs / Fields

- **Style:** Paper Surface, one-pixel border, 6px corners, and 42px minimum height.
- **Focus:** Primary border plus the shared three-pixel focus ring.
- **Error / Disabled:** Exception Red text for error; reduced opacity for disabled controls.

### Navigation

Top tabs use ordinary button semantics, muted inactive text, and a two-pixel selected underline. The row scrolls horizontally on narrow screens without inventing a custom mobile menu.

### Operational Tables

Tables use a quiet tinted header, full-width row dividers, and horizontal overflow on small screens. Failed rows receive a pale exception tint while retaining an explicit failure label.

## 6. Do's and Don'ts

### Do:

- **Do** lead every view with its operational purpose and one primary action.
- **Do** keep routine order work separate from infrequent integration settings.
- **Do** use progressive disclosure for mappings, tokens, and raw provider responses.
- **Do** preserve RTL reading while rendering phone numbers, IDs, and API data LTR.
- **Do** maintain 42px controls, visible keyboard focus, and reduced-motion behavior.

### Don't:

- **Don't** use a card-heavy setup wizard.
- **Don't** use arbitrary numbering or decorative dashboard clutter.
- **Don't** expose excessive technical copy before an operator asks for detail.
- **Don't** return to dark styling that makes routine daytime work feel like an incident console.
- **Don't** use colored side-stripe borders, gradient text, glassmorphism, or nested cards.
- **Don't** rely on color alone to communicate status.
