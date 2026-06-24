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

    const { id, voteType } = req.body;

    // 2. Валидация на входните данни
    if (!id || !voteType) {
        return res.status(400).json({ success: false, error: 'Липсва ID на сигнала или тип глас.' });
    }

    if (voteType !== 'still_there' && voteType !== 'fixed') {
        return res.status(400).json({ success: false, error: 'Невалиден тип гласуване.' });
    }

    try {
        // 3. Вземаме текущото състояние на сигнала от Supabase
        const { data: signal, error: fetchError } = await supabase
            .from('signals')
            .select('votes_still_there, votes_fixed, status')
            .eq('id', id)
            .single();

        if (fetchError || !signal) {
            return res.status(404).json({ success: false, error: 'Сигналът не е намерен.' });
        }

        // Ако сигналът вече е решен, няма нужда да се гласува повече
        if (signal.status === 'Разрешен от граждани' || signal.status === 'Разрешен') {
            return res.status(400).json({ success: false, error: 'Този проблем вече е маркиран като решен!' });
        }

        // 4. Изчисляваме новите стойности на броячите
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
