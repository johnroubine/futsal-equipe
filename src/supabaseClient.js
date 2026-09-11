import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    "Variables Supabase manquantes. Crée un fichier .env.local avec VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY (voir README.md)."
  );
}

export const supabase = createClient(url || "", anonKey || "");
