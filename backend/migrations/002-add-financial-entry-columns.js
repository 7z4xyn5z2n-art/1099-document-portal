exports.up = (pgm) => {
  pgm.addColumns('financial_entries', {
    month: {
      type: 'int'
    },
    year: {
      type: 'int'
    },
    original_amount: {
      type: 'numeric'
    },
    original_category: {
      type: 'text'
    },
    original_description: {
      type: 'text'
    },
    original_vendor_or_payor: {
      type: 'text'
    },
    reviewed_amount: {
      type: 'numeric'
    },
    reviewed_category: {
      type: 'text'
    },
    reviewed_description: {
      type: 'text'
    },
    reviewed_vendor_or_payor: {
      type: 'text'
    },
    included_in_pl: {
      type: 'boolean',
      default: true
    },
    is_overridden: {
      type: 'boolean',
      default: false
    },
    override_reason: {
      type: 'text'
    },
    reviewed_at: {
      type: 'timestamp'
    },
    updated_at: {
      type: 'timestamp',
      default: pgm.func('now()')
    }
  }, {
    ifNotExists: true
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('financial_entries', [
    'month',
    'year',
    'original_amount',
    'original_category',
    'original_description',
    'original_vendor_or_payor',
    'reviewed_amount',
    'reviewed_category',
    'reviewed_description',
    'reviewed_vendor_or_payor',
    'included_in_pl',
    'is_overridden',
    'override_reason',
    'reviewed_at',
    'updated_at'
  ], {
    ifExists: true
  });
};
