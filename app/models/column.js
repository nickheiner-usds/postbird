var Column = global.Model.Column = Model.base.extend({
  init: function (name, data) {
    if (typeof name == 'object') {
      this._super({});
      Object.keys(name).forEach((attr) => {
        this[attr] = name[attr];
      });

      // set defaults
      if (this.default_value === undefined) {
        this.default_value = null;
      }

      // reset changes on initialization
      this.changes = {};

    } else {
      this._super(data);
      this.name = name;
    }
    //this.is_primary_key = this. //
  },

  update: function(formData, callback) {
    for (var attr in formData) {
      this[attr] = formData[attr];
    }

    this.save(callback);
    // TODO: finish here
  },

  save: function(callback) {
    this.shouldHaveTable();
    if (!this.changes || Object.keys(this.changes).length == 0) {
      //console.log("no changes");
      callback();
      return;
    }

    this.save_renameColumn((res1, err1) => {
      this.save_alterType((res2, err2) => {
        this.save_alterNullable((res3, err3) => {
          this.save_alterDefault((res4, err4) => {
            delete this.changes;
            callback(res4, err1 || err2 || err3 || err4);
          });
        });
      });
    });
  },

  save_renameColumn: function (callback) {
    if (this.changes['name']) {
      var oldName = this.changes['name'][0];
      var newName = this.changes['name'][1];
      this.q('ALTER TABLE %s RENAME COLUMN %s TO %s;', this.table.table, oldName, newName, (rows, error) => {
        if (!error) {
          delete this.changes['name'];
        }
        callback(rows, error);
      });
    } else {
      callback();
    }
  },

  // TODO: http://www.postgresql.org/docs/9.1/static/sql-altertable.html
  save_alterType: function (callback) {
    if (this.changes['type'] || this.changes['max_length']) {
      this.shouldHaveTable();
      var type_with_length = this.max_length ? this.type + "(" + this.max_length + ")" : this.type;
      sql = "ALTER TABLE %s ALTER COLUMN %s TYPE %s USING %s::%s;"
      this.q(sql, this.table.table, this.name, type_with_length, this.name, this.type, (data, error) => {
        if (!error) {
          delete this.changes['type'];
          delete this.changes['max_length'];
        }
        callback(data, error);
      });
    } else {
      callback();
    }
  },

  save_alterNullable: function(callback) {
    if (this.changes['allow_null']) {
      var null_sql = this.allow_null ? "DROP NOT NULL" : "SET NOT NULL";
      sql = "ALTER TABLE %s ALTER COLUMN %s %s;"
      this.q(sql, this.table.table, this.name, null_sql, (data, error) => {
        callback(data, error);
      });
    } else {
      callback();
    }
  },

  save_alterDefault: function(callback) {
    if (this.changes['default_value']) {
      var sql;
      if (this.default_value == undefined || this.default_value == '') {
        return this.q(`ALTER TABLE ${this.table.table} ALTER COLUMN ${this.name} DROP DEFAULT;`, (data, error) => {
          callback(data, error);
        });
      } else {
        var sql = `ALTER TABLE "${this.table.table}" ALTER COLUMN "${this.name}" SET ${this._default_sql(this.default_value)};`
        return this.q(sql, (data, error) => {
          callback(data, error);
        });
      }
    } else {
      callback();
      return Promise.resolve(null);
    }
  },

  drop: function (callback) {
    this.shouldHaveTable();
    this.q("ALTER TABLE %s DROP COLUMN %s", this.table.table, this.name, (data, error) => {
      callback(data, error);
    });
  },

  shouldHaveTable: function() {
    if (!this.table) {
      throw new Error("Column should be attached to table. column.table property should be set.");
    }
  },

  _default_sql: function (default_value) {
    if (default_value !== undefined && default_value !== '') {
      return 'DEFAULT ' + JSON.stringify(default_value).replace(/^"/, "'").replace(/"$/, "'")
    } else {
      return '';
    }
  }
});

Model.Column.attributesAliases = {
  name: 'column_name',
  type: 'data_type',
  default_value: 'column_default',
  max_length: 'character_maximum_length'
};

Object.keys(Model.Column.attributesAliases).forEach((attr) => {
  var data_attr = Model.Column.attributesAliases[attr];
  Object.defineProperty(Model.Column.prototype, attr, {
    get: function () {
      return this.data[data_attr];
    },

    set: function (value) {
      if (attr == 'max_length') {
        value = parseInt(value, 10);
        if (isNaN(value)) value = null;
      }
      if (this.data[data_attr] != value) {
        this.changes = this.changes || {};
        this.changes[attr] = [this.data[data_attr], value];
        this.data[data_attr] = value;
      }
      return this.data[data_attr];
    }
  });
});

// accept and return true/false
// handle inside "YES" and "FALSE"

Object.defineProperty(Model.Column.prototype, "allow_null", {
  get: function () {
    return (this.data.is_nullable == 'YES');
  },

  set: function (value) {
    // convert pseudo true (1, "1", "true") => true
    value = [true, "true", 1, "1", "yes"].indexOf(value) != -1;
    var newValue = value ? "YES" : "NO";
    if (newValue != this.data.is_nullable) {
      this.changes = this.changes || {};
      this.changes['allow_null'] = [this.allow_null, value];
      this.data.is_nullable = newValue;
    }

    return this.data.is_nullable == "YES";
  }
});

Object.defineProperty(Model.Column.prototype, "attributes", {
  get: function () {
    return {
      name: this.name,
      type: this.type,
      default_value: this.default_value,
      max_length: this.max_length,
      allow_null: this.allow_null
    };
  }
});

Model.Column.availableTypes = function (callback) {
  var sql = `
    SELECT n.nspname as "schema",
      pg_catalog.format_type(t.oid, NULL) AS "name",
      pg_catalog.obj_description(t.oid, 'pg_type') as "description"
    FROM pg_catalog.pg_type t
         LEFT JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE (t.typrelid = 0 OR (SELECT c.relkind = 'c' FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid)
      AND pg_catalog.pg_type_is_visible(t.oid)
    ORDER BY 1, 2;
  `.trim();

  return Model.base.q(sql).then(data => {
    callback && callback(data.rows);
    return Promise.resolve(data.rows);
  });
};

module.exports = Column;
