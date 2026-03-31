const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://qxsyxemaxlgrqyksqnpe.supabase.co';
const PRO_PRICE_ID = 'price_1TFlIjI3RU9VVJJm5IqIIiCy';
const PLUS_PRICE_ID = 'price_1TGNBCI3RU9VVJJmTAcpjFKt';

exports.handler = async (event) => {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // We only care about successful payments
  if (stripeEvent.type === 'checkout.session.completed' ||
      stripeEvent.type === 'invoice.payment_succeeded') {

    const supabase = createClient(
      SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    let customerEmail = null;
    let priceId = null;

    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      customerEmail = session.customer_details?.email || session.customer_email;

      // Get the price ID from line items
      try {
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
        priceId = lineItems.data[0]?.price?.id;
      } catch (e) {
        console.error('Could not fetch line items:', e.message);
      }

    } else if (stripeEvent.type === 'invoice.payment_succeeded') {
      const invoice = stripeEvent.data.object;
      customerEmail = invoice.customer_email;
      priceId = invoice.lines?.data[0]?.price?.id;
    }

    if (!customerEmail) {
      console.error('No customer email found in event');
      return { statusCode: 200, body: 'No email found, skipping' };
    }

    // Determine which plan
    let plan = 'pro';
    if (priceId === PLUS_PRICE_ID) plan = 'plus';
    else if (priceId === PRO_PRICE_ID) plan = 'pro';

    console.log(`Activating plan "${plan}" for ${customerEmail}`);

    // Find teacher by matching auth user email, then update their plan
    // We look up the auth user by email using the admin API
    const { data: users, error: userError } = await supabase.auth.admin.listUsers();
    if (userError) {
      console.error('Error listing users:', userError.message);
      return { statusCode: 500, body: 'Error looking up user' };
    }

    const user = users.users.find(u => u.email?.toLowerCase() === customerEmail.toLowerCase());
    if (!user) {
      console.error(`No user found with email: ${customerEmail}`);
      return { statusCode: 200, body: 'User not found, skipping' };
    }

    const { error: updateError } = await supabase
      .from('teachers')
      .update({ plan, is_pro: true })
      .eq('id', user.id);

    if (updateError) {
      console.error('Error updating teacher plan:', updateError.message);
      return { statusCode: 500, body: 'Error updating plan' };
    }

    console.log(`✅ Plan "${plan}" activated for user ${user.id} (${customerEmail})`);
  }

  // Handle subscription cancellation
  if (stripeEvent.type === 'customer.subscription.deleted') {
    const subscription = stripeEvent.data.object;
    const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Get customer email from Stripe
    try {
      const customer = await stripe.customers.retrieve(subscription.customer);
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
