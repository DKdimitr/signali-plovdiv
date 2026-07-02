// File: /api/close-signal.js
import { createClient } from '@supabase/supabase-js';

// 🔑 ИЗПОЛЗВАМЕ SERVICE_ROLE_KEY, за да прескочим RLS защитите при ъпдейт
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  // 1. Позволяваме САМО POST заявки
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Методът не е разрешен.' });
  }

  const { id, token } = req.body;

  // 2. Валидация на входните данни
  if (!id || !token) {
    return res.status(400).json({ success: false, error: 'Липсва ID на сигнала или идентификационен токен.' });
  }

  try {
    // 3. Вземаме сигнала от Supabase заедно с неговия таен owner_token
    const { data: existingSignal, error: fetchOwnerError } = await supabase
      .from('signals')
      .select('owner_token')
      .eq('id', id)
      .single();

    if (fetchOwnerError || !existingSignal) {
      return res.status(404).json({ success: false, error: 'Сигналът не е намерен.' });
    }

    // 4. ВАЛИДАЦИЯ: Проверяваме съвпадението на токените
    if (existingSignal.owner_token !== token) {
      return res.status(403).json({ success: false, error: 'Грешен или невалиден токен за управление.' });
    }

    // 5. Обновяваме статуса директно без допълнителни изисквания за гласове
    const { error: updateOwnerError } = await supabase
      .from('signals')
      .update({ status: 'Разрешен от граждани' })
      .eq('id', id);

    if (updateOwnerError) throw updateOwnerError;

    // 6. Връщаме успешен отговор към фронтенда
    return res.status(200).json({
      success: true,
      message: 'Благодарим Ви! Вие затворихте Вашия сигнал успешно.',
      current_status: 'Разрешен от граждани'
    });

  } catch (err) {
    console.error('Грешка при затваряне на сигнал от автор:', err);
    return res.status(500).json({ success: false, error: 'Вътрешна сървърна грешка при прекратяване на сигнала.' });
  }
}
