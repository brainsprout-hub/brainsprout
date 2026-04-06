const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://qxsyxemaxlgrqyksqnpe.supabase.co';
const PRO_PRICE_ID = 'price_1TJ39uI3RU9VVJJmTha52QY4';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Payment succeeded — activate Pro
  if (stripeEvent.type === 'checkout.session.completed' ||
      stripeEvent.type === 'invoice.payment_succeeded') {

    let customerEmail = null;

    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      customerEmail = session.customer_details?.email || session.customer_email;
    } else {
      customerEmail = stripeEvent.data.object.customer_email;
    }

    if (!customerEmail) {
      console.error('No customer email found');
      return { statusCode: 200, body: 'No email, skipping' };
    }

    console.log(`Activating Pro for ${customerEmail}`);

    const { data: users, error: userError } = await supabase.auth.admin.listUsers();
    if (userError) {
      console.error('Error listing users:', userError.message);
      return { statusCode: 500, body: 'Error looking up user' };
    }

    const user = users.users.find(u => u.email?.toLowerCase() === customerEmail.toLowerCase());
    if (!user) {
      console.error(`No user found: ${customerEmail}`);
      return { statusCode: 200, body: 'User not found' };
    }

    const { error: updateError } = await supabase
      .from('teachers')
      .update({ plan: 'pro', is_pro: true })
      .eq('id', user.id);

    if (updateError) {
      console.error('Error updating plan:', updateError.message);
      return { statusCode: 500, body: 'Error updating plan' };
    }

    console.log(`Pro activated for ${customerEmail}`);
  }

  // Subscription cancelled — revert to free
  if (stripeEvent.type === 'customer.subscription.deleted') {
    try {
      const customer = await stripe.customers.retrieve(stripeEvent.data.object.customer);
      const email = customer.email;
      if (email) {
        const { data: users } = await supabase.auth.admin.listUsers();
        const user = users?.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
        if (user) {
          await supabase.from('teachers').update({ plan: 'free', is_pro: false }).eq('id', user.id);
          console.log(`Plan reset to free for ${email}`);
        }
      }
    } catch (e) {
      console.error('Error handling cancellation:', e.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
