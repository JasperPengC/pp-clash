package mobile

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/metacubex/mihomo/component/geodata/router"
	"github.com/oschwald/maxminddb-golang"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

const maxGeoSize int64 = 64 * 1024 * 1024

type geoSource struct {
	geoEntry
	URL       string `json:"url"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

func geoSourcePath(dir, name string) string {
	return filepath.Join(dir, ".geodata-source-"+name+".json")
}

func readGeoSource(dir, name string) (geoSource, bool) {
	var record geoSource
	path := geoSourcePath(dir, name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 8192 {
		return record, false
	}
	file, err := os.Open(path)
	if err != nil {
		return record, false
	}
	defer file.Close()
	err = json.NewDecoder(io.LimitReader(file, 8192)).Decode(&record)
	digest, decodeErr := hex.DecodeString(record.SHA256)
	return record, err == nil && decodeErr == nil && len(digest) == 32 && record.Size > 0 && record.Size <= maxGeoSize &&
		(strings.HasPrefix(record.URL, "https://") || strings.HasPrefix(record.URL, "http://"))
}

func validUserGeodata(dir, path, name string) bool {
	record, ok := readGeoSource(dir, name)
	if !ok {
		return false
	}
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() == record.Size &&
		matchesGeodata(path, record.geoEntry) && validateGeoFormat(path, name) == nil
}

func validateGeoFormat(path, name string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxGeoSize {
		return fmt.Errorf("Geo 数据必须是 64 MB 以内的普通文件")
	}
	if name == "geoip.metadb" || name == "ASN.mmdb" {
		reader, err := maxminddb.Open(path)
		if err != nil {
			return fmt.Errorf("MMDB 数据格式无效：%w", err)
		}
		defer reader.Close()
		kind := reader.Metadata.DatabaseType
		if name == "ASN.mmdb" {
			if kind != "GeoLite2-ASN" && kind != "DBIP-ASN-Lite (compat=GeoLite2-ASN)" && kind != "ipinfo generic_asn_free.mmdb" {
				return fmt.Errorf("数据库不包含 mihomo 支持的 ASN 数据")
			}
		} else if kind != "Meta-geoip0" && kind != "sing-geoip" && !strings.Contains(kind, "Country") && !strings.Contains(kind, "City") {
			return fmt.Errorf("数据库不包含国家 GeoIP 数据")
		}
		// MetaDB legally reuses pointers into packed records and omits Description;
		// maxminddb.Verify rejects both. Decode every reachable record instead.
		if kind == "Meta-geoip0" || kind == "sing-geoip" {
			return validateCompactMMDB(reader, kind)
		}
		if err := reader.Verify(); err != nil {
			return fmt.Errorf("MMDB 数据损坏：%w", err)
		}
		return nil
	}
	if name != "geoip.dat" && name != "geosite.dat" {
		return fmt.Errorf("不支持的 Geo 数据格式")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxGeoSize+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > maxGeoSize {
		return fmt.Errorf("Geo 数据超过 64 MB")
	}
	entries, values := 0, 0
	// Decode one protobuf group at a time to bound allocations for large datasets.
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 || number != 1 || wireType != protowire.BytesType {
			return fmt.Errorf("DAT 数据格式无效")
		}
		data = data[length:]
		entry, length := protowire.ConsumeBytes(data)
		if length < 0 || len(entry) > 8*1024*1024 {
			return fmt.Errorf("DAT 分组格式无效或超过 8 MB")
		}
		data = data[length:]
		entries++
		if entries > 100000 {
			return fmt.Errorf("DAT 分组过多")
		}
		if name == "geoip.dat" {
			var group router.GeoIP
			if proto.Unmarshal(entry, &group) != nil || group.CountryCode == "" || !utf8.ValidString(group.CountryCode) {
				return fmt.Errorf("GeoIP DAT 分组无效")
			}
			for _, cidr := range group.Cidr {
				if cidr == nil || (len(cidr.Ip) != 4 && len(cidr.Ip) != 16) || cidr.Prefix > uint32(len(cidr.Ip)*8) {
					return fmt.Errorf("GeoIP DAT IP 范围无效")
				}
			}
			values += len(group.Cidr)
		} else {
			var group router.GeoSite
			if proto.Unmarshal(entry, &group) != nil || group.CountryCode == "" || !utf8.ValidString(group.CountryCode) {
				return fmt.Errorf("GeoSite DAT 分组无效")
			}
			for _, domain := range group.Domain {
				if domain == nil || domain.Value == "" || len(domain.Value) > 4096 || !utf8.ValidString(domain.Value) || domain.Type < router.Domain_Plain || domain.Type > router.Domain_Full {
					return fmt.Errorf("GeoSite DAT 域名无效")
				}
				if domain.Type == router.Domain_Regex {
					if _, err := regexp.Compile(domain.Value); err != nil {
						return fmt.Errorf("GeoSite DAT 正则表达式无效")
					}
				}
			}
			values += len(group.Domain)
		}
	}
	if entries == 0 || values == 0 {
		return fmt.Errorf("DAT 数据没有可用规则")
	}
	return nil
}

func validateCompactMMDB(reader *maxminddb.Reader, kind string) error {
	if reader.Metadata.NodeCount == 0 {
		return fmt.Errorf("MMDB 没有可用数据")
	}
	networks := reader.Networks(maxminddb.SkipAliasedNetworks)
	count := 0
	for networks.Next() {
		count++
		if count > 2000000 {
			return fmt.Errorf("MMDB IP 范围超过上限")
		}
		var value any
		if _, err := networks.Network(&value); err != nil {
			return fmt.Errorf("MMDB 数据损坏：%w", err)
		}
		validCode := func(code string) bool { return code != "" && len(code) <= 256 && utf8.ValidString(code) }
		switch value := value.(type) {
		case string:
			if !validCode(value) {
				return fmt.Errorf("MMDB 国家代码无效")
			}
		case []any:
			if kind != "Meta-geoip0" || len(value) == 0 || len(value) > 128 {
				return fmt.Errorf("MMDB 国家代码列表无效")
			}
			for _, item := range value {
				code, ok := item.(string)
				if !ok || !validCode(code) {
					return fmt.Errorf("MMDB 国家代码无效")
				}
			}
		default:
			return fmt.Errorf("MMDB 国家数据类型无效")
		}
	}
	if err := networks.Err(); err != nil {
		return fmt.Errorf("MMDB 索引损坏：%w", err)
	}
	if count == 0 {
		return fmt.Errorf("MMDB 没有可用数据")
	}
	return nil
}
