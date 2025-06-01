import { createClient } from '@supabase/supabase-js';

export let supabase;

export const initDB = async () => {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
};
