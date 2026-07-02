// File: /api/vote-signals.js
import { createClient } from '@supabase/supabase-js';

// 🔑 ИЗПОЛЗВАМЕ SERVICE_ROLE_KEY, за да може бекендът безопасно да прескача RLS защитите при ъпдейт на статус!
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  // 1. Позволяваме САМО POST заявки (еквивалентно на app.post)
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Методът не е разрешен.' });
  }

  const { id, voteType, token } = req.body; // Приемаме и токен от тялото на заявката

  // 2. Валидация на входните данни
  if (!id || !voteType) {
    return res.status(400).json({ success: false, error: 'Липсва ID на сигнала или тип глас.' });
  }

  // ДОБАВЕНО: Разрешаваме и новия тип вотинг от автора на сигнала
  if (voteType !== 'still_there' && voteType !== 'fixed' && voteType !== 'resolve_by_owner') {
    return res.status(400).json({ success: false, error: 'Невалиден тип гласуване.' });
  }

  try {
    // =========================================================================
    // НОВА ХЕНДЛЪР ЛОГИКА: ДИРЕКТНО ЗАТВАРЯНЕ ОТ СОБСТВЕНИКА НА СИГНАЛА
    // =========================================================================
    if (voteType === 'resolve_by_owner') {
      if (!token) {
        return res.status(401).json({ success: false, error: 'Липсва идентификационен токен.' });
      }

      // Вземаме сигнала от Supabase заедно с неговия таен owner_token
      const { data: existingSignal, error: fetchOwnerError } = await supabase
        .from('signals')
        .select('owner_token')
        .eq('id', id)
        .single();

      if (fetchOwnerError || !existingSignal) {
        return res.status(404).json({ success: false, error: 'Сигналът не е намерен.' });
      }

      // ВАЛИДАЦИЯ: Проверяваме съвпадението на токените
      if (existingSignal.owner_token !== token) {
        return res.status(403).json({ success: false, error: 'Грешен или невалиден токен за управление.' });
      }

      // Обновяваме статуса директно без допълнителни гласувания
      const { error: updateOwnerError } = await supabase
        .from('signals')
        .update({ status: 'Разрешен от граждани' })
        .eq('id', id);

      if (updateOwnerError) throw updateOwnerError;

      return res.status(200).json({
        success: true,
        message: 'Благодарим Ви! Вие затворихте Вашия сигнал успешно.',
        current_status: 'Разрешен от граждани'
      });
    }

    // =========================================================================
    // СЕГАШНАТА ТИ КРАУДСОРСИНГ ЛОГИКА (ОСТАВА НАПЪЛНО НЕПРОМЕНЕНА)
    // =========================================================================
    const { data: signal, error: fetchError } = await supabase
      .from('signals')
      .select('votes_still_there, votes_fixed, status')
      .eq('id', id)
      .single();

    if (fetchError) {
      throw fetchError;
    }

    if (signal.status === 'Разрешен от граждани') {
      return res.status(400).json({ success: false, error: 'Този сигнал вече е маркиран като разрешен.' });
    }

    let updatedVotesStillThere = signal.votes_still_there || 0;
    let updatedVotesFixed = signal.votes_fixed || 0;
    let newStatus = signal.status;

    if (voteType === 'still_there') {
      updatedVotesStillThere += 1;
    } else if (voteType === 'fixed') {
      updatedVotesFixed += 1;
      
      // Ключовата бизнес логика: Ако стигнем 3 гласа "Оправен", затваряме сигнала!
      if (updatedVotesFixed >= 3) {
        newStatus = 'Разрешен от граждани';
      }
    }

    // 5. Обновяваме данните в Supabase (сега вече успешно, благодарение на service_role ключа)
    const { data: updatedData, error: updateError } = await supabase
      .from('signals')
      .update({ 
        votes_still_there: updatedVotesStillThere,
        votes_fixed: updatedVotesFixed,
        status: newStatus
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    // 6. Връщаме детайлен отговор към фронт-енда
    return res.status(200).json({
      success: true,
      message: updatedVotesFixed >= 3 
        ? 'Благодарим Ви! Сигналът беше затворен успешно от гражданите.' 
        : 'Гласът Ви бе успешно отчетен!',
      current_status: newStatus,
      votes_fixed: updatedVotesFixed,
      votes_still_there: updatedVotesStillThere
    });

    } catch (err) {
        console.error('Грешка при краудсорсинг гласуване:', err);
        return res.status(500).json({ success: false, error: 'Вътрешна сървърна грешка при обработка на вота.' });
    }
}
