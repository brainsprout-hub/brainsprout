const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://qxsyxemaxlgrqyksqnpe.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { userId, userEmail } = JSON.parse(event.body || '{}');
  if (!userId || !userEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing user info' }) };
  }

  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Find the Stripe customer by email
    const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
    if (!customers.data.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No Stripe customer found' }) };
    }
    const customerId = customers.data[0].id;

    // Find their active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1
    });
    if (!subscriptions.data.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No active subscription found' }) };
    }
    const subscriptionId = subscriptions.data[0].id;

    // Cancel at period end (keeps access until billing period ends)
    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true
    });

    // Update Supabase — mark as canceling
    await supabase.from('teachers')
      .update({ plan: 'canceling' })
      .eq('id', userId);

    const periodEnd = new Date(subscriptions.data[0].current_period_end * 1000)
      .toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, periodEnd })
    };

  } catch (err) {
    console.error('Cancel error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
