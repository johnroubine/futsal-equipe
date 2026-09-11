import { supabase } from "./supabaseClient";

// Reproduit la petite API window.storage (get/set) de l'artefact Claude,
// mais soutenue par une table Supabase partagée par toute l'équipe.
// Table attendue (voir README.md pour le SQL) :
//   app_data (key text primary key, value jsonb, updated_at timestamptz)

export const storage = {
  async get(key) {
    const { data, error } = await supabase
      .from("app_data")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { key, value: JSON.stringify(data.value) };
  },

  async set(key, value) {
    const parsed = JSON.parse(value);
    const { error } = await supabase
      .from("app_data")
      .upsert({ key, value: parsed, updated_at: new Date().toISOString() });
    if (error) throw error;
    return { key, value };
  },
};
