"use client";

import { useMemo } from "react";

import { normalizeVietnameseText } from "@/utils/text";

export default function useVietnameseText(value: unknown) {
  return useMemo(() => normalizeVietnameseText(value), [value]);
}
